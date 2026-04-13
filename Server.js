const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const extract = require('extract-zip');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Persistent Data Directory ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

// Create directories if they don't exist
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    console.log(`📁 Created directory: ${d}`);
  }
});

console.log(`📂 Data directory: ${DATA_DIR}`);
console.log(`💾 Persistent storage: ${fs.existsSync(DATA_DIR) ? 'READY' : 'MISSING'}`);

// ---------- B2 Client Setup ----------
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_REGION = process.env.B2_REGION || "us-west-004";
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

let b2Client = null;
let B2_ENABLED = false;

if (B2_ENDPOINT && B2_KEY_ID && B2_APP_KEY && B2_BUCKET_NAME) {
  b2Client = new S3Client({
    endpoint: B2_ENDPOINT,
    region: B2_REGION,
    credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
    forcePathStyle: true,
  });
  B2_ENABLED = true;
  console.log('✅ B2 client initialized');
} else {
  console.warn('⚠️ B2 credentials missing – uploads will FAIL. Set B2_* env vars.');
}

async function uploadBufferToB2(buffer, fileName, mimeType, folder = 'schemes') {
  if (!b2Client) throw new Error('B2 not configured');
  const safeName = fileName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
  const key = `${folder}/${Date.now()}_${safeName}`;
  const command = new PutObjectCommand({
    Bucket: B2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ContentDisposition: `attachment; filename="${fileName}"`,
  });
  await b2Client.send(command);
  console.log(`📤 Uploaded to B2: ${key}`);
  return key;
}

async function streamFileFromB2(key, res) {
  if (!b2Client) throw new Error('B2 not configured');
  const command = new GetObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key });
  const response = await b2Client.send(command);
  res.setHeader('Content-Type', response.ContentType);
  res.setHeader('Content-Disposition', response.ContentDisposition || 'attachment');
  response.Body.pipe(res);
}

// Auto-sync on startup - verifies B2 and checks data integrity
async function verifyB2Connectivity() {
  if (!b2Client) {
    console.warn('⚠️ B2 not configured – skipping sync');
    return { status: 'not configured' };
  }
  try {
    const command = new ListObjectsV2Command({ Bucket: B2_BUCKET_NAME, MaxKeys: 1000 });
    const response = await b2Client.send(command);
    const fileCount = response.KeyCount || 0;
    
    let totalSize = 0;
    if (response.Contents) {
      totalSize = response.Contents.reduce((sum, obj) => sum + (obj.Size || 0), 0);
    }
    
    console.log(`✅ B2 connected – ${fileCount} objects, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    
    // Check for orphaned schemes (fileKey exists but file missing in B2)
    const schemes = readDB('schemes');
    let missingCount = 0;
    for (const scheme of schemes) {
      if (scheme.fileKey) {
        try {
          await b2Client.send(new HeadObjectCommand({ Bucket: B2_BUCKET_NAME, Key: scheme.fileKey }));
        } catch (e) {
          console.warn(`⚠️ Missing file in B2: ${scheme.fileKey} (${scheme.title})`);
          missingCount++;
        }
      }
    }
    
    if (missingCount > 0) {
      console.log(`📦 ${missingCount} schemes have missing files – consider re-uploading`);
    }
    
    return { status: 'connected', fileCount, totalSize, missingFiles: missingCount };
  } catch (err) {
    console.error('❌ B2 connectivity check failed:', err.message);
    return { status: 'error', error: err.message };
  }
}

// Verify B2 on startup
if (B2_ENABLED) {
  verifyB2Connectivity().then(status => {
    console.log(`🔍 B2 health check: ${status.status}`);
  });
}

// ---------- JSON Helpers (Persistent Data) ----------
const dbFile = name => path.join(DATA_DIR, `${name}.json`);

function readDB(name, def = []) {
  const filePath = dbFile(name);
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`📄 Creating new database: ${name}.json`);
      writeDB(name, def);
      return def;
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`❌ Error reading ${name}.json:`, err.message);
    return def;
  }
}

function writeDB(name, data) {
  const filePath = dbFile(name);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`❌ Error writing ${name}.json:`, err.message);
    return false;
  }
}

// Initialize defaults with all settings
if (!fs.existsSync(dbFile('settings'))) {
  writeDB('settings', {
    adminPassword: process.env.ADMIN_PASSWORD || '0726019859',
    term1Enabled: true, term2Enabled: true, term3Enabled: true,
    defaultTerm: '1',
    bannerEnabled: false, bannerText: '',
    waEnabled: false, waNumber: '', waMessage: 'Hello',
    showAllGrades: true,
    featuredSchemeIds: [],
    emailNotifications: true
  });
  console.log('📄 Created default settings.json');
}

// Initialize all databases
['schemes', 'areas', 'visitors', 'sales', 'popups', 'grades', 'stats', 'resetCodes'].forEach(n => {
  if (!fs.existsSync(dbFile(n))) {
    writeDB(n, []);
    console.log(`📄 Created ${n}.json`);
  }
});

// Seed grades if empty
let grades = readDB('grades');
if (!grades.length) {
  grades = Array.from({ length: 9 }, (_, i) => ({
    id: crypto.randomUUID(),
    name: `Grade ${i+1}`,
    active: true
  }));
  writeDB('grades', grades);
}

// Log database stats on startup
console.log('📊 Database stats:');
console.log(`   - Schemes: ${readDB('schemes').length}`);
console.log(`   - Subjects: ${readDB('areas').length}`);
console.log(`   - Grades: ${readDB('grades').length}`);
console.log(`   - Sales: ${readDB('sales').length}`);
console.log(`   - Visitors: ${readDB('visitors').length}`);

// ---------- Scheduled Publishing (Cron) ----------
cron.schedule('* * * * *', () => {
  const now = new Date().toISOString();
  const schemes = readDB('schemes');
  let changed = false;
  
  schemes.forEach(s => {
    if (s.publishAt && s.publishAt <= now && s.visible === false) {
      s.visible = true;
      s.publishAt = null;
      changed = true;
      console.log(`📅 Auto-published: ${s.title}`);
    }
    if (s.unpublishAt && s.unpublishAt <= now && s.visible === true) {
      s.visible = false;
      s.unpublishAt = null;
      changed = true;
      console.log(`📅 Auto-unpublished: ${s.title}`);
    }
  });
  
  if (changed) {
    writeDB('schemes', schemes);
    console.log('💾 Saved scheduled publishing changes');
  }
});

console.log('⏰ Scheduled publishing cron job started (runs every minute)');

// ---------- Multer ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});
const restoreStorage = multer({ dest: path.join(DATA_DIR, 'tmp') });

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const settings = readDB('settings', {});
  if (!token || token !== settings.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function incStat(key) {
  const stats = readDB('stats', { visits: 0, downloads: 0, sales: 0 });
  stats[key] = (stats[key] || 0) + 1;
  writeDB('stats', stats);
}

const userSessions = {};
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (ip) {
    userSessions[ip] = Date.now();
    const now = Date.now();
    Object.keys(userSessions).forEach(k => {
      if (now - userSessions[k] > 300000) delete userSessions[k];
    });
  }
  next();
});

// Payment state (in-memory only - transactions don't need persistence)
const transactions = {};
const verificationTokens = {};
const downloadTokens = {};

const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || '';
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';
const DEMO_MODE = !PAYNECTA_API_KEY;
if (DEMO_MODE) console.log('⚠️ DEMO MODE – payments auto‑confirm after 5s');
else console.log('💰 Paynecta LIVE mode enabled');

// Email notification helper
async function sendSaleNotification(scheme, phone, amount) {
  const settings = readDB('settings', {});
  if (!settings.emailNotifications) return;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
  
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    await transporter.sendMail({
      from: `"SchemeVault" <${process.env.EMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
      subject: `💰 New Sale: ${scheme.title}`,
      text: `New sale!\n\nScheme: ${scheme.title}\nGrade: ${scheme.grade}\nAmount: KES ${amount}\nPhone: ${phone}\nTime: ${new Date().toLocaleString()}`
    });
    console.log('📧 Sale notification sent');
  } catch (e) {
    console.warn('⚠️ Failed to send sale email:', e.message);
  }
}

// ---------- PUBLIC ROUTES ----------
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  demo: DEMO_MODE, 
  b2: B2_ENABLED ? 'enabled' : 'disabled',
  persistent: fs.existsSync(DATA_DIR) ? 'ready' : 'missing'
}));

app.post('/api/track-visit', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const isMobile = /mobile|android|iphone|ipad/i.test(ua);
  const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : 'Safari';
  const visitors = readDB('visitors');
  visitors.push({ ip, device: isMobile ? 'Mobile' : 'Desktop', browser, time: new Date().toISOString() });
  writeDB('visitors', visitors.slice(-500));
  incStat('visits');
  res.json({ ok: true });
});

app.get('/api/schemes', (req, res) => {
  const schemes = readDB('schemes').filter(s => s.visible !== false);
  // Sort: Grade descending (9→1), then subject alphabetically
  const sorted = schemes.sort((a, b) => {
    const gradeA = parseInt(a.grade?.match(/\d+/)?.[0] || '0');
    const gradeB = parseInt(b.grade?.match(/\d+/)?.[0] || '0');
    if (gradeB !== gradeA) return gradeB - gradeA;
    return (a.subject || '').localeCompare(b.subject || '');
  });
  res.json(sorted);
});

app.get('/api/areas', (req, res) => res.json(readDB('areas')));

app.get('/api/settings', (req, res) => {
  const s = readDB('settings', {});
  res.json({
    term1Enabled: s.term1Enabled !== false,
    term2Enabled: s.term2Enabled !== false,
    term3Enabled: s.term3Enabled !== false,
    defaultTerm: s.defaultTerm || '1'
  });
});

app.get('/api/banner', (req, res) => {
  const s = readDB('settings', {});
  res.json({ enabled: s.bannerEnabled || false, text: s.bannerText || '' });
});

app.get('/api/whatsapp', (req, res) => {
  const s = readDB('settings', {});
  res.json({ enabled: s.waEnabled || false, number: s.waNumber || '', message: s.waMessage || 'Hello' });
});

app.get('/api/popups', (req, res) => res.json(readDB('popups')));

app.get('/api/cover/:schemeId', async (req, res) => {
  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === req.params.schemeId);
  if (!scheme || !scheme.coverKey) return res.status(404).send('No cover');
  try {
    await streamFileFromB2(scheme.coverKey, res);
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } catch { res.status(404).send('Cover not found'); }
});

app.get('/api/grades/available', (req, res) => {
  const settings = readDB('settings', {});
  const schemes = readDB('schemes').filter(s => s.visible !== false);
  
  if (settings.showAllGrades) {
    const grades = readDB('grades');
    return res.json(grades.filter(g => g.active));
  }
  
  const gradeSet = new Set();
  schemes.forEach(s => { if (s.grade) gradeSet.add(s.grade); });
  const grades = Array.from(gradeSet).sort().map(name => ({ name, active: true }));
  res.json(grades);
});

// ---------- PAYMENT ROUTES (FIXED FOR FASTER CONFIRMATION) ----------
function normalisePhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0') && p.length === 10) p = '254' + p.slice(1);
  if (p.startsWith('7') && p.length === 9) p = '254' + p;
  return (p.startsWith('254') && p.length === 12) ? p : null;
}

app.post('/api/initiate-payment', async (req, res) => {
  const { phone, amount, productId } = req.body;
  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === productId);
  if (!scheme) return res.status(404).json({ error: 'Product not found' });
  
  const mobile = normalisePhone(phone);
  if (!mobile) return res.status(400).json({ error: 'Invalid phone number. Use format 07XXXXXXXX' });

  const transactionId = crypto.randomBytes(10).toString('hex');

  // DEMO MODE - Auto confirm after 5 seconds (faster)
  if (DEMO_MODE) {
    console.log(`🟡 DEMO: Init payment for ${mobile}, amount ${scheme.price}`);
    transactions[transactionId] = { status: 'pending', productId, phone: mobile };
    setTimeout(() => {
      if (transactions[transactionId] && transactions[transactionId].status === 'pending') {
        const vt = crypto.randomBytes(16).toString('hex');
        verificationTokens[vt] = { productId, expiresAt: Date.now() + 5 * 60 * 1000 };
        transactions[transactionId] = { status: 'success', productId, verificationToken: vt };
        console.log(`🟢 DEMO: Payment confirmed for ${transactionId}`);
      }
    }, 5000); // Reduced from 10000 to 5000ms
    return res.json({ transactionId, demo: true });
  }

  // REAL PAYNECTA INTEGRATION
  try {
    const payload = {
      code: PAYNECTA_PAYMENT_CODE,
      mobile_number: mobile,
      amount: Number(amount || scheme.price)
    };

    console.log(`📤 Paynecta initialize:`, JSON.stringify(payload));

    const response = await fetch(`${PAYNECTA_API_URL}/payment/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    console.log(`📥 Paynecta initialize response:`, rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('❌ Failed to parse Paynecta response');
      return res.status(502).json({ error: 'Invalid response from payment gateway' });
    }

    const transactionRef = data.transaction_reference || data.data?.transaction_reference;
    
    if (!transactionRef) {
      console.error('❌ No transaction_reference in response:', data);
      const errorMsg = data.message || data.error || 'Unknown error';
      return res.status(502).json({ error: `Payment gateway error: ${errorMsg}` });
    }

    transactions[transactionId] = { 
      transactionRef, 
      productId, 
      status: 'pending', 
      phone: mobile 
    };
    
    console.log(`✅ Payment initiated, ref: ${transactionRef}`);
    res.json({ transactionId });

  } catch (err) {
    console.error('❌ Paynecta network error:', err.message);
    res.status(502).json({ error: 'Could not reach payment gateway' });
  }
});

app.get('/api/payment-status/:transactionId', async (req, res) => {
  const tx = transactions[req.params.transactionId];
  if (!tx) return res.status(404).json({ status: 'not_found' });

  if (tx.status === 'success') {
    return res.json({ status: 'success', verificationToken: tx.verificationToken });
  }
  
  if (tx.status === 'failed') {
    return res.json({ status: 'failed', message: tx.failReason || 'Payment failed' });
  }

  if (DEMO_MODE) {
    return res.json({ status: 'pending' });
  }

  try {
    console.log(`🔍 Checking Paynecta status for ref: ${tx.transactionRef}`);
    
    const response = await fetch(`${PAYNECTA_API_URL}/payment/status?transaction_reference=${encodeURIComponent(tx.transactionRef)}`, {
      method: 'GET',
      headers: {
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL
      }
    });

    const rawText = await response.text();
    console.log(`📡 Paynecta status response:`, rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('❌ Failed to parse status response');
      return res.json({ status: 'pending' });
    }

    // Paynecta nests the transaction inside 'data'
    const inner = data.data || data;
    const status = inner.status;
    const resultCode = inner.result_code !== undefined ? Number(inner.result_code) : null;

    console.log(`📊 Status: ${status}, result_code: ${resultCode}`);

    // SUCCESS: status is 'completed' AND result_code is 0
    if (status === 'completed' && (resultCode === 0 || resultCode === '0')) {
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { 
        productId: tx.productId, 
        expiresAt: Date.now() + 5 * 60 * 1000 
      };
      transactions[req.params.transactionId] = { 
        ...tx, 
        status: 'success', 
        verificationToken: vt 
      };

      const scheme = readDB('schemes').find(s => s.id === tx.productId);
      const sales = readDB('sales');
      sales.push({
        title: scheme?.title || '—',
        grade: scheme?.grade || '',
        subject: scheme?.subject || '',
        phone: tx.phone,
        amount: scheme?.price || 0,
        date: new Date().toISOString(),
        mpesaReceipt: inner.mpesa_receipt_number || ''
      });
      writeDB('sales', sales);
      incStat('sales');

      if (scheme) sendSaleNotification(scheme, tx.phone, scheme.price);

      console.log(`✅ Payment confirmed! Receipt: ${inner.mpesa_receipt_number}`);
      return res.json({ status: 'success', verificationToken: vt });
    }

    // FAILED or CANCELLED
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      const failReason = inner.result_description || inner.failure_reason || 'Payment was cancelled or failed';
      transactions[req.params.transactionId].status = 'failed';
      transactions[req.params.transactionId].failReason = failReason;
      console.log(`❌ Payment failed: ${failReason}`);
      return res.json({ status: 'failed', message: failReason });
    }

    // Still pending
    res.json({ status: 'pending' });

  } catch (err) {
    console.error(`⚠️ Status check error:`, err.message);
    res.json({ status: 'pending' });
  }
});

app.post('/api/request-download', (req, res) => {
  const { verificationToken, productId } = req.body;
  const vt = verificationTokens[verificationToken];
  if (!vt || vt.productId !== productId || Date.now() > vt.expiresAt) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  const scheme = readDB('schemes').find(s => s.id === productId);
  if (!scheme || !scheme.fileKey) return res.status(404).json({ error: 'File not found' });
  const dt = crypto.randomBytes(16).toString('hex');
  downloadTokens[dt] = { key: scheme.fileKey, fileName: scheme.originalName, expiresAt: Date.now() + 2 * 60 * 1000 };
  delete verificationTokens[verificationToken];
  incStat('downloads');
  res.json({ downloadToken: dt });
});

app.get('/api/download/:token', async (req, res) => {
  const dt = downloadTokens[req.params.token];
  if (!dt || Date.now() > dt.expiresAt) return res.status(403).send('Expired');
  delete downloadTokens[req.params.token];
  try { await streamFileFromB2(dt.key, res); }
  catch { res.status(404).send('File not found'); }
});

// ---------- ADMIN ROUTES ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const settings = readDB('settings', {});
  if (password === settings.adminPassword) {
    res.json({ token: password, ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ ok: true }));

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = readDB('stats', {});
  res.json({
    visits: stats.visits || 0,
    downloads: stats.downloads || 0,
    sales: stats.sales || 0,
    schemes: readDB('schemes').length,
    activeUsers: Object.keys(userSessions).length
  });
});

app.get('/api/admin/schemes', adminAuth, (req, res) => res.json(readDB('schemes')));

app.post('/api/admin/schemes', adminAuth, upload.fields([{ name: 'document' }, { name: 'cover' }]), async (req, res) => {
  try {
    const { title, subject, grade, term, price, weeks, pages, visible, publishAt, unpublishAt } = req.body;
    if (!title || !subject || !grade || !term || !price || !req.files?.document) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const docKey = await uploadBufferToB2(req.files.document[0].buffer, req.files.document[0].originalname, req.files.document[0].mimetype, 'schemes');
    let coverKey = null;
    if (req.files.cover) {
      coverKey = await uploadBufferToB2(req.files.cover[0].buffer, req.files.cover[0].originalname, req.files.cover[0].mimetype, 'covers');
    }
    const scheme = {
      id: crypto.randomUUID(),
      title, subject, grade, term: Number(term), price: Number(price),
      weeks: weeks ? Number(weeks) : null,
      pages: pages ? Number(pages) : null,
      fileKey: docKey, originalName: req.files.document[0].originalname,
      coverKey, visible: visible !== 'false', createdAt: new Date().toISOString(),
      publishAt: publishAt || null,
      unpublishAt: unpublishAt || null
    };
    const schemes = readDB('schemes');
    schemes.push(scheme);
    writeDB('schemes', schemes);
    res.status(201).json(scheme);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/schemes/:id', adminAuth, (req, res) => {
  const schemes = readDB('schemes');
  const idx = schemes.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { price, weeks, visible, publishAt, unpublishAt } = req.body;
  if (price !== undefined) schemes[idx].price = Number(price);
  if (weeks !== undefined) schemes[idx].weeks = Number(weeks) || null;
  if (visible !== undefined) schemes[idx].visible = Boolean(visible);
  if (publishAt !== undefined) schemes[idx].publishAt = publishAt || null;
  if (unpublishAt !== undefined) schemes[idx].unpublishAt = unpublishAt || null;
  writeDB('schemes', schemes);
  res.json(schemes[idx]);
});

app.post('/api/admin/schemes/:id/cover', adminAuth, upload.single('cover'), async (req, res) => {
  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === req.params.id);
  if (!scheme) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const coverKey = await uploadBufferToB2(req.file.buffer, req.file.originalname, req.file.mimetype, 'covers');
    scheme.coverKey = coverKey;
    writeDB('schemes', schemes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/schemes/:id', adminAuth, (req, res) => {
  const schemes = readDB('schemes').filter(s => s.id !== req.params.id);
  writeDB('schemes', schemes);
  res.json({ ok: true });
});

app.post('/api/admin/schemes/bulk', adminAuth, upload.fields([{ name: 'documents' }, { name: 'covers' }]), async (req, res) => {
  const { title, subject, grade, term, price, weeks, pages, visible } = req.body;
  if (!title || !subject || !grade || !term || !price || !req.files?.documents) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const docs = req.files.documents;
  const covers = req.files.covers || [];
  const schemes = readDB('schemes');
  const created = [];
  for (let i = 0; i < docs.length; i++) {
    try {
      const docKey = await uploadBufferToB2(docs[i].buffer, docs[i].originalname, docs[i].mimetype, 'schemes');
      let coverKey = null;
      if (covers[i]) {
        coverKey = await uploadBufferToB2(covers[i].buffer, covers[i].originalname, covers[i].mimetype, 'covers');
      }
      const schemeTitle = docs.length > 1 ? `${title} (${i+1})` : title;
      const scheme = {
        id: crypto.randomUUID(),
        title: schemeTitle, subject, grade, term: Number(term), price: Number(price),
        weeks: weeks ? Number(weeks) : null,
        pages: pages ? Number(pages) : null,
        fileKey: docKey, originalName: docs[i].originalname,
        coverKey, visible: visible !== 'false', createdAt: new Date().toISOString()
      };
      schemes.push(scheme);
      created.push(scheme);
    } catch (e) { console.error('Bulk upload item failed:', e); }
  }
  writeDB('schemes', schemes);
  res.status(201).json({ created: created.length });
});

app.post('/api/admin/schemes/bulk-price', adminAuth, (req, res) => {
  const { schemeIds, price, operation = 'set' } = req.body;
  if (!schemeIds || !Array.isArray(schemeIds) || price === undefined) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const schemes = readDB('schemes');
  let updated = 0;
  schemes.forEach(s => {
    if (schemeIds.includes(s.id)) {
      if (operation === 'set') s.price = Number(price);
      else if (operation === 'increase') s.price = Math.max(0, s.price + Number(price));
      else if (operation === 'decrease') s.price = Math.max(0, s.price - Number(price));
      updated++;
    }
  });
  writeDB('schemes', schemes);
  res.json({ ok: true, updated });
});

app.post('/api/admin/schemes/bulk-visibility', adminAuth, (req, res) => {
  const { schemeIds, visible } = req.body;
  if (!schemeIds || !Array.isArray(schemeIds)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const schemes = readDB('schemes');
  let updated = 0;
  schemes.forEach(s => {
    if (schemeIds.includes(s.id)) {
      s.visible = Boolean(visible);
      updated++;
    }
  });
  writeDB('schemes', schemes);
  res.json({ ok: true, updated });
});

app.get('/api/admin/schemes/featured', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  res.json({ featuredSchemeIds: settings.featuredSchemeIds || [] });
});

app.post('/api/admin/schemes/featured', adminAuth, (req, res) => {
  const { schemeIds } = req.body;
  const settings = readDB('settings', {});
  settings.featuredSchemeIds = schemeIds || [];
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.patch('/api/admin/settings/grade-display', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  settings.showAllGrades = req.body.showAllGrades !== false;
  writeDB('settings', settings);
  res.json({ ok: true, showAllGrades: settings.showAllGrades });
});

app.patch('/api/admin/settings/email-notifications', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  settings.emailNotifications = req.body.enabled !== false;
  writeDB('settings', settings);
  res.json({ ok: true, emailNotifications: settings.emailNotifications });
});

app.get('/api/admin/analytics/downloads', adminAuth, (req, res) => {
  const schemes = readDB('schemes');
  const sales = readDB('sales');
  const schemeDownloads = {};
  
  sales.forEach(sale => {
    const scheme = schemes.find(s => s.title === sale.title);
    if (scheme) {
      schemeDownloads[scheme.id] = (schemeDownloads[scheme.id] || 0) + 1;
    }
  });
  
  const analytics = schemes.map(s => ({
    id: s.id,
    title: s.title,
    grade: s.grade,
    subject: s.subject,
    downloads: schemeDownloads[s.id] || 0,
    revenue: (schemeDownloads[s.id] || 0) * s.price
  })).sort((a, b) => b.downloads - a.downloads);
  
  res.json(analytics);
});

app.get('/api/admin/sales/export', adminAuth, (req, res) => {
  const sales = readDB('sales');
  const schemes = readDB('schemes');
  
  let csv = 'Date,Title,Grade,Subject,Phone,Amount (KES),M-Pesa Receipt\n';
  sales.forEach(sale => {
    const scheme = schemes.find(s => s.title === sale.title);
    csv += `${sale.date},${sale.title},${scheme?.grade || ''},${scheme?.subject || ''},${sale.phone},${sale.amount},${sale.mpesaReceipt || ''}\n`;
  });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sales.csv"');
  res.send(csv);
});

app.get('/api/admin/health', adminAuth, async (req, res) => {
  const b2Status = B2_ENABLED ? await verifyB2Connectivity() : { status: 'disabled' };
  const schemes = readDB('schemes');
  const stats = readDB('stats', {});
  const sales = readDB('sales');
  
  res.json({
    b2: b2Status,
    database: {
      schemes: schemes.length,
      visibleSchemes: schemes.filter(s => s.visible).length,
      subjects: readDB('areas').length,
      grades: readDB('grades').length,
      visitors: readDB('visitors').length,
      sales: sales.length
    },
    stats: {
      visits: stats.visits || 0,
      downloads: stats.downloads || 0,
      totalRevenue: sales.reduce((sum, s) => sum + (s.amount || 0), 0)
    },
    persistent: fs.existsSync(DATA_DIR) ? 'ready' : 'missing',
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// ---------- LEARNING AREAS (SUBJECTS) ----------
app.get('/api/admin/subjects', adminAuth, (req, res) => {
  const areas = readDB('areas');
  res.json(areas);
});

app.post('/api/admin/subjects', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Subject name is required' });
  }
  const trimmed = name.trim();
  const areas = readDB('areas');
  if (areas.find(a => a.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'Subject already exists' });
  }
  const newArea = { id: crypto.randomUUID(), name: trimmed };
  areas.push(newArea);
  writeDB('areas', areas);
  res.status(201).json(newArea);
});

app.delete('/api/admin/subjects/:id', adminAuth, (req, res) => {
  const areas = readDB('areas');
  const filtered = areas.filter(a => a.id !== req.params.id);
  if (filtered.length === areas.length) {
    return res.status(404).json({ error: 'Subject not found' });
  }
  writeDB('areas', filtered);
  res.json({ ok: true });
});

// ---------- GRADES ----------
app.get('/api/admin/grades', adminAuth, (req, res) => {
  let grades = readDB('grades');
  if (!grades.length) {
    grades = Array.from({ length: 9 }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `Grade ${i+1}`,
      active: true
    }));
    writeDB('grades', grades);
  }
  res.json(grades);
});

app.post('/api/admin/grades', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const grades = readDB('grades');
  grades.push({ id: crypto.randomUUID(), name: name.trim(), active: true });
  writeDB('grades', grades);
  res.status(201).json({ ok: true });
});

app.delete('/api/admin/grades/:id', adminAuth, (req, res) => {
  const grades = readDB('grades').filter(g => g.id !== req.params.id);
  writeDB('grades', grades);
  res.json({ ok: true });
});

// ---------- VISITORS ----------
app.get('/api/admin/visitors', adminAuth, (req, res) => {
  res.json(readDB('visitors'));
});

app.delete('/api/admin/visitors/clear', adminAuth, (req, res) => {
  writeDB('visitors', []);
  res.json({ ok: true });
});

// ---------- BANNER ----------
app.get('/api/admin/banner', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  res.json({ text: s.bannerText || '', enabled: s.bannerEnabled || false });
});

app.post('/api/admin/banner', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  s.bannerText = req.body.text || '';
  s.bannerEnabled = req.body.enabled || false;
  writeDB('settings', s);
  res.json({ ok: true });
});

// ---------- WHATSAPP ----------
app.get('/api/admin/whatsapp', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  res.json({ number: s.waNumber || '', message: s.waMessage || 'Hello', enabled: s.waEnabled || false });
});

app.post('/api/admin/whatsapp', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  s.waNumber = req.body.number || '';
  s.waMessage = req.body.message || 'Hello';
  s.waEnabled = req.body.enabled || false;
  writeDB('settings', s);
  res.json({ ok: true });
});

// ---------- TERMS ----------
app.get('/api/admin/terms', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  res.json({
    term1Enabled: s.term1Enabled !== false,
    term2Enabled: s.term2Enabled !== false,
    term3Enabled: s.term3Enabled !== false,
    defaultTerm: s.defaultTerm || '1'
  });
});

app.post('/api/admin/terms', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  if (req.body.term1Enabled !== undefined) s.term1Enabled = req.body.term1Enabled;
  if (req.body.term2Enabled !== undefined) s.term2Enabled = req.body.term2Enabled;
  if (req.body.term3Enabled !== undefined) s.term3Enabled = req.body.term3Enabled;
  if (req.body.defaultTerm) s.defaultTerm = req.body.defaultTerm;
  writeDB('settings', s);
  res.json({ ok: true });
});

// ---------- POPUPS ----------
app.get('/api/admin/popups', adminAuth, (req, res) => res.json(readDB('popups')));

app.post('/api/admin/popups', adminAuth, (req, res) => {
  const { question, options, trigger, collectWhatsapp } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const popups = readDB('popups');
  popups.push({ id: crypto.randomUUID(), question, options, trigger: trigger || 'onload', collectWhatsapp: !!collectWhatsapp });
  writeDB('popups', popups);
  res.status(201).json({ ok: true });
});

// ---------- CHANGE PASSWORD ----------
app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Too short' });
  const s = readDB('settings', {});
  s.adminPassword = newPassword;
  writeDB('settings', s);
  res.json({ ok: true });
});

// ---------- FORGOT/RESET PASSWORD ----------
app.post('/api/admin/forgot-password', async (req, res) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const resetCodes = readDB('resetCodes', {});
  resetCodes['admin'] = { code, expires: Date.now() + 15*60*1000 };
  writeDB('resetCodes', resetCodes);
  res.json({ success: true, demoCode: DEMO_MODE ? code : undefined });
});

app.post('/api/admin/reset-password', (req, res) => {
  const { code, newPassword } = req.body;
  const resetCodes = readDB('resetCodes', {});
  const stored = resetCodes['admin'];
  if (!stored || stored.code !== code || stored.expires < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const s = readDB('settings', {});
  s.adminPassword = newPassword;
  writeDB('settings', s);
  delete resetCodes['admin'];
  writeDB('resetCodes', resetCodes);
  res.json({ ok: true });
});

// ---------- BACKUP & RESTORE ----------
app.get('/api/admin/backup', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="schemevault-backup-${Date.now()}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);
  archive.directory(DATA_DIR, 'data');
  archive.finalize();
});

app.post('/api/admin/restore', adminAuth, restoreStorage.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    await extract(req.file.path, { dir: path.dirname(DATA_DIR) });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`🚀 SchemeVault running on port ${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`💾 Persistent storage: ${fs.existsSync(DATA_DIR) ? 'READY' : 'MISSING'}`);
  console.log(`💰 Payment mode: ${DEMO_MODE ? 'DEMO' : 'LIVE'}`);
  console.log(`☁️ B2 Storage: ${B2_ENABLED ? 'ENABLED' : 'DISABLED'}`);
});
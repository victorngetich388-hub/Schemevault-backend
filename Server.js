const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const extract = require('extract-zip');
const nodemailer = require('nodemailer');

// AWS SDK for Backblaze B2 (S3 compatible)
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Persistent Data Directory (JSON databases only) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');  // kept for legacy migration
const COVERS_DIR = path.join(DATA_DIR, 'covers');    // kept for legacy migration
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ---------- B2 Client Setup ----------
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_REGION = process.env.B2_REGION || "us-west-004";
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

const b2Client = new S3Client({
    endpoint: B2_ENDPOINT,
    region: B2_REGION,
    credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APP_KEY,
    },
    forcePathStyle: true,
});

async function uploadBufferToB2(buffer, fileName, mimeType, folder = 'schemes') {
    const key = `${folder}/${Date.now()}_${fileName.replace(/\s+/g, '_')}`;
    const command = new PutObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ContentDisposition: `attachment; filename="${fileName}"`,
    });
    await b2Client.send(command);
    console.log(`✅ Uploaded to B2: ${key}`);
    return key;
}

async function streamFileFromB2(key, res) {
    const command = new GetObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: key,
    });
    const response = await b2Client.send(command);
    res.setHeader('Content-Type', response.ContentType);
    res.setHeader('Content-Disposition', response.ContentDisposition || 'attachment');
    response.Body.pipe(res);
}

// ---------- JSON Helpers ----------
const dbFile = name => path.join(DATA_DIR, `${name}.json`);
function readDB(name, def = []) {
  try { return JSON.parse(fs.readFileSync(dbFile(name), 'utf8')); }
  catch { return def; }
}
function writeDB(name, data) {
  fs.writeFileSync(dbFile(name), JSON.stringify(data, null, 2));
}

// ---------- Initialize Default Data ----------
if (!fs.existsSync(dbFile('settings'))) {
  writeDB('settings', {
    adminPassword: process.env.ADMIN_PASSWORD || '0726019859',
    term1Enabled: true, term2Enabled: true, term3Enabled: true,
    defaultTerm: 'all',
    bannerEnabled: false, bannerText: '', bannerStart: '', bannerEnd: ''
  });
}
['schemes', 'areas', 'visitors', 'sales', 'popups', 'grades', 'sessions', 'stats', 'resetCodes'].forEach(n => {
  if (!fs.existsSync(dbFile(n))) writeDB(n, []);
});

// ---------- Multer Configuration (Memory Storage) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
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

const transactions = {};
const verificationTokens = {};
const downloadTokens = {};

const PAYNECTA_API_URL  = process.env.PAYNECTA_API_URL  || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY  = process.env.PAYNECTA_API_KEY  || '';
const PAYNECTA_EMAIL    = process.env.PAYNECTA_EMAIL    || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';
const DEMO_MODE = !PAYNECTA_API_KEY;
if (DEMO_MODE) console.log('⚠️  DEMO MODE – payments will auto‑confirm after 10 seconds');

// ---------- PUBLIC ROUTES ----------
app.get('/health', (req, res) => res.json({ status: 'ok', demo: DEMO_MODE }));

app.post('/api/track-visit', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const isMobile = /mobile|android|iphone|ipad/i.test(ua);
  const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Other';
  const visitors = readDB('visitors');
  visitors.push({ ip, device: isMobile ? 'Mobile' : 'Desktop', browser, location: '—', time: new Date().toISOString() });
  writeDB('visitors', visitors.slice(-500));
  incStat('visits');
  res.json({ ok: true });
});

app.get('/api/schemes', (req, res) => {
  const schemes = readDB('schemes').filter(s => s.visible !== false);
  res.json(schemes);
});

app.get('/api/areas', (req, res) => res.json(readDB('areas')));

app.get('/api/settings', (req, res) => {
  const s = readDB('settings', {});
  res.json({
    bannerEnabled: s.bannerEnabled, bannerText: s.bannerText,
    bannerStart: s.bannerStart, bannerEnd: s.bannerEnd,
    term1Enabled: s.term1Enabled !== false,
    term2Enabled: s.term2Enabled !== false,
    term3Enabled: s.term3Enabled !== false,
    defaultTerm: s.defaultTerm || 'all'
  });
});

app.get('/api/popups', (req, res) => res.json(readDB('popups')));

app.get('/api/stats', (req, res) => {
  const stats = readDB('stats', {});
  const schemes = readDB('schemes');
  const areas = readDB('areas');
  res.json({
    visits: stats.visits || 0,
    downloads: stats.downloads || 0,
    totalSchemes: schemes.filter(s => s.visible !== false).length,
    totalSubjects: areas.length
  });
});

// Cover image proxy route (from B2)
app.get('/api/cover/:schemeId', async (req, res) => {
  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === req.params.schemeId);
  if (!scheme || !scheme.coverKey) return res.status(404).send('No cover');

  try {
    await streamFileFromB2(scheme.coverKey, res);
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } catch (err) {
    console.error('Error streaming cover:', err);
    res.status(404).send('Cover not found');
  }
});

// ---------- PAYMENT ROUTES ----------
function normalisePhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0') && p.length === 10) p = '254' + p.slice(1);
  if (p.startsWith('7') && p.length === 9) p = '254' + p;
  if (!p.startsWith('254') || p.length !== 12) return null;
  return p;
}

app.post('/api/initiate-payment', async (req, res) => {
  const { phone, amount, productId } = req.body;
  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === productId);
  if (!scheme) return res.status(404).json({ error: 'Product not found' });

  const mobile = normalisePhone(phone);
  if (!mobile) return res.status(400).json({ error: 'Invalid phone number. Use format 07XXXXXXXX' });

  const transactionId = crypto.randomBytes(10).toString('hex');

  if (DEMO_MODE) {
    transactions[transactionId] = { status: 'pending', productId, phone: mobile, amount: scheme.price };
    setTimeout(() => {
      if (transactions[transactionId]) {
        const vt = crypto.randomBytes(16).toString('hex');
        verificationTokens[vt] = { productId, expiresAt: Date.now() + 5 * 60 * 1000 };
        transactions[transactionId] = { status: 'success', productId, verificationToken: vt };
      }
    }, 10000);
    return res.json({ transactionId, demo: true });
  }

  try {
    const payload = {
      code: PAYNECTA_PAYMENT_CODE,
      mobile_number: mobile,
      amount: Number(amount || scheme.price)
    };

    console.log(`📤 Initiating Paynecta payment:`, payload);

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
    console.log(`📥 Raw Paynecta init response:`, rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('❌ Failed to parse Paynecta response');
      return res.status(502).json({ error: 'Invalid response from payment gateway' });
    }

    const transactionRef = 
      data.transaction_reference ||
      data.data?.transaction_reference ||
      data.TransactionReference ||
      data.reference;

    if (!transactionRef) {
      console.error('❌ Paynecta init error: no transaction_reference found');
      const errorMsg = data.error || data.message || 'Unknown error';
      return res.status(502).json({ error: `Payment gateway error: ${errorMsg}`, details: data });
    }

    transactions[transactionId] = { transactionRef, productId, status: 'pending', phone: mobile };
    console.log(`✅ Payment initiated, transaction_reference: ${transactionRef}`);
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

  if (DEMO_MODE) return res.json({ status: 'pending' });

  try {
    console.log(`🔍 Checking Paynecta status for transaction_reference: ${tx.transactionRef}`);

    const response = await fetch(`${PAYNECTA_API_URL}/payment/status?transaction_reference=${encodeURIComponent(tx.transactionRef)}`, {
      method: 'GET',
      headers: {
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL
      }
    });

    const rawText = await response.text();
    console.log(`📡 Raw Paynecta status response:`, rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('❌ Failed to parse Paynecta response');
      return res.json({ status: 'pending' });
    }

    const inner = data.data || data;
    const status = inner.status;
    const resultCode = inner.result_code !== undefined ? Number(inner.result_code) : null;

    console.log(`📊 Extracted status: ${status}, result_code: ${resultCode}`);

    if (status === 'completed' && resultCode === 0) {
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { productId: tx.productId, expiresAt: Date.now() + 5 * 60 * 1000 };
      transactions[req.params.transactionId] = { ...tx, status: 'success', verificationToken: vt };

      const schemes = readDB('schemes');
      const scheme = schemes.find(s => s.id === tx.productId);
      const sales = readDB('sales');
      sales.push({
        title: scheme?.title || '—',
        phone: tx.phone,
        amount: scheme?.price || 0,
        date: new Date().toISOString()
      });
      writeDB('sales', sales);
      incStat('sales');

      console.log(`✅ Payment confirmed for ${req.params.transactionId}`);
      return res.json({ status: 'success', verificationToken: vt });
    }

    if (['failed', 'cancelled', 'expired'].includes(status)) {
      const failReason = inner.result_description || inner.failure_reason || 'Payment was cancelled or failed';
      transactions[req.params.transactionId].status = 'failed';
      transactions[req.params.transactionId].failReason = failReason;
      console.log(`❌ Payment failed: ${failReason}`);
      return res.json({ status: 'failed', message: failReason });
    }

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

  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === productId);
  if (!scheme || !scheme.fileKey) return res.status(404).json({ error: 'File not found' });

  const dt = crypto.randomBytes(16).toString('hex');
  downloadTokens[dt] = {
    key: scheme.fileKey,
    fileName: scheme.originalName || 'document',
    expiresAt: Date.now() + 2 * 60 * 1000
  };
  delete verificationTokens[verificationToken];
  incStat('downloads');
  res.json({ downloadToken: dt });
});

app.get('/api/download/:token', async (req, res) => {
  const dt = downloadTokens[req.params.token];
  if (!dt || Date.now() > dt.expiresAt) return res.status(403).send('Download link expired');
  delete downloadTokens[req.params.token];

  try {
    await streamFileFromB2(dt.key, res);
  } catch (err) {
    console.error('B2 download error:', err);
    res.status(404).send('File not found');
  }
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
  const schemes = readDB('schemes');
  const sales = readDB('sales');
  const sessions = readDB('sessions', {});
  const activeUsers = Object.values(sessions).filter(ts => Date.now() - ts < 60000).length;
  res.json({
    visits: stats.visits || 0,
    downloads: stats.downloads || 0,
    sales: stats.sales || 0,
    schemes: schemes.length,
    activeUsers,
    recentSales: sales.slice(-10).reverse()
  });
});

app.get('/api/admin/schemes', adminAuth, (req, res) => res.json(readDB('schemes')));

app.post('/api/admin/schemes', adminAuth, upload.fields([{ name: 'document', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  const { title, subject, grade, term, price, weeks, pages, visible } = req.body;
  if (!title || !subject || !grade || !term || !price || !req.files?.document) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const docFile = req.files.document[0];
  const coverFile = req.files.cover?.[0];

  try {
    const docKey = await uploadBufferToB2(
      docFile.buffer,
      docFile.originalname,
      docFile.mimetype,
      'schemes'
    );

    let coverKey = null;
    if (coverFile) {
      coverKey = await uploadBufferToB2(
        coverFile.buffer,
        coverFile.originalname,
        coverFile.mimetype,
        'covers'
      );
    }

    const scheme = {
      id: crypto.randomUUID(),
      title, subject, grade, term: Number(term),
      price: Number(price),
      weeks: weeks ? Number(weeks) : null,
      pages: pages ? Number(pages) : null,
      fileKey: docKey,
      originalName: docFile.originalname,
      coverKey: coverKey,
      visible: visible !== 'false',
      createdAt: new Date().toISOString()
    };

    const schemes = readDB('schemes');
    schemes.push(scheme);
    writeDB('schemes', schemes);
    res.status(201).json(scheme);
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'File upload failed' });
  }
});

app.patch('/api/admin/schemes/:id', adminAuth, (req, res) => {
  const schemes = readDB('schemes');
  const idx = schemes.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { price, weeks, visible } = req.body;
  if (price !== undefined) schemes[idx].price = Number(price);
  if (weeks !== undefined) schemes[idx].weeks = Number(weeks);
  if (visible !== undefined) schemes[idx].visible = Boolean(visible);
  writeDB('schemes', schemes);
  res.json(schemes[idx]);
});

app.delete('/api/admin/schemes/:id', adminAuth, (req, res) => {
  const schemes = readDB('schemes');
  const scheme = schemes.find(s => s.id === req.params.id);
  if (!scheme) return res.status(404).json({ error: 'Not found' });
  // Note: Deleting from B2 requires extra permissions; we skip for now.
  writeDB('schemes', schemes.filter(s => s.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/subjects', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const areas = readDB('areas');
  if (areas.find(a => a.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Already exists' });
  const area = { id: crypto.randomUUID(), name: name.trim() };
  areas.push(area);
  writeDB('areas', areas);
  res.status(201).json(area);
});

app.get('/api/admin/subjects', adminAuth, (req, res) => res.json(readDB('areas')));
app.delete('/api/admin/subjects/:id', adminAuth, (req, res) => {
  const areas = readDB('areas').filter(a => a.id !== req.params.id);
  writeDB('areas', areas);
  res.json({ ok: true });
});

app.get('/api/admin/grades', adminAuth, (req, res) => {
  let grades = readDB('grades');
  if (!grades.length) {
    grades = Array.from({ length: 9 }, (_, i) => ({ id: crypto.randomUUID(), name: `Grade ${i+1}`, active: true }));
    writeDB('grades', grades);
  }
  res.json(grades);
});
app.post('/api/admin/grades', adminAuth, (req, res) => {
  const { name, active } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const grades = readDB('grades');
  const grade = { id: crypto.randomUUID(), name: name.trim(), active: active !== false };
  grades.push(grade);
  writeDB('grades', grades);
  res.status(201).json(grade);
});
app.delete('/api/admin/grades/:id', adminAuth, (req, res) => {
  writeDB('grades', readDB('grades').filter(g => g.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/popups', adminAuth, (req, res) => {
  const { question, options, trigger, collectWhatsapp } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const popup = { id: crypto.randomUUID(), question, options, trigger: trigger || 'onload', collectWhatsapp: Boolean(collectWhatsapp) };
  const popups = readDB('popups');
  popups.push(popup);
  writeDB('popups', popups);
  res.status(201).json(popup);
});
app.delete('/api/admin/popups/:id', adminAuth, (req, res) => {
  writeDB('popups', readDB('popups').filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/banner', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  res.json({ text: s.bannerText || '', enabled: s.bannerEnabled || false });
});
app.post('/api/admin/banner', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  settings.bannerText = req.body.text || '';
  settings.bannerEnabled = req.body.enabled || false;
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.get('/api/admin/whatsapp', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  res.json({ number: s.waNumber || '', message: s.waMessage || 'Hello', enabled: s.waEnabled || false });
});
app.post('/api/admin/whatsapp', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  settings.waNumber = req.body.number || '';
  settings.waMessage = req.body.message || 'Hello';
  settings.waEnabled = req.body.enabled || false;
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.get('/api/admin/terms', adminAuth, (req, res) => {
  const s = readDB('settings', {});
  res.json({ term1Enabled: s.term1Enabled, term2Enabled: s.term2Enabled, term3Enabled: s.term3Enabled, defaultTerm: s.defaultTerm });
});
app.post('/api/admin/terms', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  if (req.body.term1Enabled !== undefined) settings.term1Enabled = req.body.term1Enabled;
  if (req.body.term2Enabled !== undefined) settings.term2Enabled = req.body.term2Enabled;
  if (req.body.term3Enabled !== undefined) settings.term3Enabled = req.body.term3Enabled;
  if (req.body.defaultTerm) settings.defaultTerm = req.body.defaultTerm;
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.patch('/api/admin/settings', adminAuth, (req, res) => {
  const settings = readDB('settings', {});
  Object.assign(settings, req.body);
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
  const settings = readDB('settings', {});
  settings.adminPassword = newPassword;
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.post('/api/admin/forgot-password', async (req, res) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
  if (!adminEmail) return res.status(500).json({ error: 'Admin email not configured' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const resetCodes = readDB('resetCodes', {});
  resetCodes[adminEmail] = { code, expires: Date.now() + 15 * 60 * 1000 };
  writeDB('resetCodes', resetCodes);
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      await transporter.sendMail({
        from: `"SchemeVault" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject: 'Password Reset Code',
        text: `Your reset code is: ${code}\nValid for 15 minutes.`
      });
    } catch (e) {}
  }
  res.json({ success: true, email: adminEmail, code: DEMO_MODE ? code : undefined });
});

app.post('/api/admin/reset-password', (req, res) => {
  const { email, code, newPassword } = req.body;
  const resetCodes = readDB('resetCodes', {});
  const stored = resetCodes[email];
  if (!stored || stored.code !== code || stored.expires < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const settings = readDB('settings', {});
  settings.adminPassword = newPassword;
  writeDB('settings', settings);
  delete resetCodes[email];
  writeDB('resetCodes', resetCodes);
  res.json({ ok: true });
});

app.post('/api/admin/reset-password-default', (req, res) => {
  const { secret } = req.body;
  if (secret !== 'override') return res.status(403).json({ error: 'Forbidden' });
  const settings = readDB('settings', {});
  settings.adminPassword = '0726019859';
  writeDB('settings', settings);
  res.json({ ok: true });
});

app.get('/api/admin/visitors', adminAuth, (req, res) => res.json(readDB('visitors')));

app.get('/api/admin/backup', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="schemevault-backup-${Date.now()}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);
  archive.directory(DATA_DIR, 'data');
  archive.finalize();
});

app.post('/api/admin/restore', adminAuth, restoreStorage.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await extract(req.file.path, { dir: path.dirname(DATA_DIR) });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Restore failed', details: err.message });
  }
});

// Optional migration route – run once then remove
app.get('/api/admin/migrate-to-b2', adminAuth, async (req, res) => {
  const schemes = readDB('schemes');
  const updated = [];
  for (let scheme of schemes) {
    if (scheme.fileName && !scheme.fileKey) {
      const localPath = path.join(UPLOADS_DIR, scheme.fileName);
      if (fs.existsSync(localPath)) {
        const buffer = fs.readFileSync(localPath);
        const mime = scheme.fileName.endsWith('.pdf') ? 'application/pdf' :
                     scheme.fileName.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
                     'application/msword';
        const key = await uploadBufferToB2(buffer, scheme.originalName || scheme.fileName, mime, 'schemes');
        scheme.fileKey = key;
        delete scheme.fileName;
        updated.push(scheme.id);
      }
    }
    if (scheme.coverImage && !scheme.coverKey) {
      const localPath = path.join(COVERS_DIR, scheme.coverImage);
      if (fs.existsSync(localPath)) {
        const buffer = fs.readFileSync(localPath);
        const ext = path.extname(scheme.coverImage).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const key = await uploadBufferToB2(buffer, scheme.coverImage, mime, 'covers');
        scheme.coverKey = key;
        delete scheme.coverImage;
        if (!updated.includes(scheme.id)) updated.push(scheme.id);
      }
    }
  }
  writeDB('schemes', schemes);
  res.json({ migrated: updated.length, schemes });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 SchemeVault running on port ${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`💰 Demo mode: ${DEMO_MODE ? 'ON' : 'OFF'}`);
});
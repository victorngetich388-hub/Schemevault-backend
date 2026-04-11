const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const extract = require('extract-zip');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Persistent Data Directory ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

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
['schemes', 'areas', 'visitors', 'sales', 'popups'].forEach(n => {
  if (!fs.existsSync(dbFile(n))) writeDB(n, []);
});

// ---------- Multer Configuration ----------
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'cover' ? COVERS_DIR : UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage: docStorage,
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
app.use('/data/covers', express.static(COVERS_DIR));
app.use('/data/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------- Admin Authentication ----------
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const settings = readDB('settings', {});
  if (!token || token !== settings.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- Stats Helpers ----------
function incStat(key) {
  const stats = readDB('stats', { visits: 0, downloads: 0, sales: 0 });
  stats[key] = (stats[key] || 0) + 1;
  writeDB('stats', stats);
}

// ---------- In-Memory Transaction Store ----------
const transactions = {};
const verificationTokens = {};
const downloadTokens = {};

// ---------- Paynecta Configuration ----------
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

// ---------- PAYMENT ROUTES (CORRECTED) ----------
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

    // Extract transaction_reference (Paynecta returns this, not checkout_request_id)
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
  if (!scheme || !scheme.fileName) return res.status(404).json({ error: 'File not found' });

  const dt = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(UPLOADS_DIR, scheme.fileName);
  downloadTokens[dt] = { filePath, fileName: scheme.originalName || scheme.fileName, expiresAt: Date.now() + 2 * 60 * 1000 };
  delete verificationTokens[verificationToken];
  incStat('downloads');
  res.json({ downloadToken: dt });
});

app.get('/api/download/:token', (req, res) => {
  const dt = downloadTokens[req.params.token];
  if (!dt || Date.now() > dt.expiresAt) return res.status(403).send('Download link expired');
  delete downloadTokens[req.params.token];

  if (!fs.existsSync(dt.filePath)) return res.status(404).send('File not found');

  const ext = path.extname(dt.fileName).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${dt.fileName}"`);
  fs.createReadStream(dt.filePath).pipe(res);
});

// ---------- ADMIN ROUTES ----------
// ... (keep all admin routes from previous full server.js) ...

app.listen(PORT, () => {
  console.log(`🚀 SchemeVault running on port ${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`💰 Demo mode: ${DEMO_MODE ? 'ON' : 'OFF'}`);
});
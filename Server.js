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

// ─── PERSISTENT DATA DIRECTORY ──────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── JSON FILE HELPERS ───────────────────────────────────────────────────────
const dbFile = name => path.join(DATA_DIR, `${name}.json`);

function readDB(name, def = []) {
  try { return JSON.parse(fs.readFileSync(dbFile(name), 'utf8')); }
  catch { return def; }
}
function writeDB(name, data) {
  fs.writeFileSync(dbFile(name), JSON.stringify(data, null, 2));
}

// ─── DEFAULTS ───────────────────────────────────────────────────────────────
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

// ─── MULTER STORAGE ──────────────────────────────────────────────────────────
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

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/data/covers', express.static(COVERS_DIR));
app.use('/data/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname)); // serves index.html, admin.html

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Admin auth middleware
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const settings = readDB('settings', {});
  if (!token || token !== settings.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── STATS HELPERS ──────────────────────────────────────────────────────────
function incStat(key) {
  const stats = readDB('stats', { visits: 0, downloads: 0, sales: 0 });
  stats[key] = (stats[key] || 0) + 1;
  writeDB('stats', stats);
}

// ─── IN-MEMORY TRANSACTION STORE ────────────────────────────────────────────
const transactions = {};
const verificationTokens = {};
const downloadTokens = {};

// ─── PAYNECTA CONFIG ─────────────────────────────────────────────────────────
const PAYNECTA_API_URL  = process.env.PAYNECTA_API_URL  || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY  = process.env.PAYNECTA_API_KEY  || '';
const PAYNECTA_EMAIL    = process.env.PAYNECTA_EMAIL    || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';
const DEMO_MODE = !PAYNECTA_API_KEY;

if (DEMO_MODE) console.log('⚠️  Paynecta env vars missing – running in DEMO MODE (auto-confirms after 10s)');

// ─── PUBLIC ROUTES ───────────────────────────────────────────────────────────

// Visitor tracking
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

// Public schemes (visible only)
app.get('/api/schemes', (req, res) => {
  const schemes = readDB('schemes').filter(s => s.visible !== false);
  res.json(schemes);
});

// Learning areas
app.get('/api/areas', (req, res) => res.json(readDB('areas')));

// Settings (public subset)
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

// Popups
app.get('/api/popups', (req, res) => res.json(readDB('popups')));

// Stats (public counts)
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

// ─── PAYMENT ROUTES ──────────────────────────────────────────────────────────

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
    const response = await fetch(`${PAYNECTA_API_URL}/payment/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL },
      body: JSON.stringify({ code: PAYNECTA_PAYMENT_CODE, mobile_number: mobile, amount: Number(amount || scheme.price) })
    });
    const data = await response.json();
    const reference = data.transaction_reference || data.checkout_request_id || data.data?.transaction_reference;
    if (!reference) {
      console.error('Paynecta init error:', data);
      return res.status(502).json({ error: 'Payment gateway error', details: data });
    }
    transactions[transactionId] = { reference, productId, status: 'pending', phone: mobile };
    res.json({ transactionId });
  } catch (err) {
    console.error('Paynecta network error:', err.message);
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
    const response = await fetch(`${PAYNECTA_API_URL}/payment/status?transaction_reference=${tx.reference}`, {
      headers: { 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL }
    });
    const data = await response.json();
    const status = data.data?.status || data.status;
    const resultCode = data.data?.result_code ?? data.result_code;

    if (status === 'completed' && resultCode === 0) {
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { productId: tx.productId, expiresAt: Date.now() + 5 * 60 * 1000 };
      transactions[req.params.transactionId] = { ...tx, status: 'success', verificationToken: vt };
      const schemes = readDB('schemes');
      const scheme = schemes.find(s => s.id === tx.productId);
      const sales = readDB('sales');
      sales.push({ title: scheme?.title || '—', phone: tx.phone, amount: scheme?.price || 0, date: new Date().toISOString() });
      writeDB('sales', sales);
      incStat('sales');
      return res.json({ status: 'success', verificationToken: vt });
    }

    if (['failed', 'cancelled', 'expired'].includes(status)) {
      transactions[req.params.transactionId].status = 'failed';
      transactions[req.params.transactionId].failReason = data.data?.result_desc || 'Payment not completed';
      return res.json({ status: 'failed', message: data.data?.result_desc || 'Payment not completed' });
    }

    res.json({ status: 'pending' });
  } catch (err) {
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
  const mimeMap = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${dt.fileName}"`);
  fs.createReadStream(dt.filePath).pipe(res);
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

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
  res.json({
    visits: stats.visits || 0,
    downloads: stats.downloads || 0,
    sales: stats.sales || 0,
    schemes: schemes.length,
    recentSales: sales.slice(-10).reverse()
  });
});

app.get('/api/admin/schemes', adminAuth, (req, res) => res.json(readDB('schemes')));

app.post('/api/admin/schemes', adminAuth, upload.fields([{ name: 'document', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  const { title, subject, grade, term, price, weeks, pages } = req.body;
  if (!title || !subject || !grade || !term || !price || !req.files?.document) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const docFile = req.files.document[0];
  const coverFile = req.files.cover?.[0];
  const scheme = {
    id: crypto.randomUUID(),
    title, subject, grade, term: Number(term),
    price: Number(price),
    weeks: weeks ? Number(weeks) : null,
    pages: pages ? Number(pages) : null,
    fileName: docFile.filename,
    originalName: docFile.originalname,
    coverImage: coverFile?.filename || null,
    visible: true,
    createdAt: new Date().toISOString()
  };
  const schemes = readDB('schemes');
  schemes.push(scheme);
  writeDB('schemes', schemes);
  res.status(201).json(scheme);
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
  [scheme.fileName && path.join(UPLOADS_DIR, scheme.fileName), scheme.coverImage && path.join(COVERS_DIR, scheme.coverImage)]
    .filter(Boolean).forEach(f => { try { fs.unlinkSync(f); } catch {} });
  writeDB('schemes', schemes.filter(s => s.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/areas', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const areas = readDB('areas');
  if (areas.find(a => a.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Already exists' });
  const area = { id: crypto.randomUUID(), name: name.trim() };
  areas.push(area);
  writeDB('areas', areas);
  res.status(201).json(area);
});

app.delete('/api/admin/areas/:id', adminAuth, (req, res) => {
  const areas = readDB('areas').filter(a => a.id !== req.params.id);
  writeDB('areas', areas);
  res.json({ ok: true });
});

app.post('/api/admin/popups', adminAuth, (req, res) => {
  const { title, body, trigger, collectWhatsApp } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  const popup = { id: crypto.randomUUID(), title, body, trigger: trigger || 'onload', collectWhatsApp: Boolean(collectWhatsApp) };
  const popups = readDB('popups');
  popups.push(popup);
  writeDB('popups', popups);
  res.status(201).json(popup);
});

app.delete('/api/admin/popups/:id', adminAuth, (req, res) => {
  writeDB('popups', readDB('popups').filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/visitors', adminAuth, (req, res) => res.json(readDB('visitors')));

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

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 SchemeVault running on http://localhost:${PORT}`);
  console.log(`   Admin portal : http://localhost:${PORT}/admin.html`);
  console.log(`   Data dir     : ${DATA_DIR}`);
  console.log(`   Demo mode    : ${DEMO_MODE ? 'YES (set Paynecta env vars to disable)' : 'NO – live payments'}\n`);
});
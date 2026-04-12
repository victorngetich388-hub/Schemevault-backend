const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const extract = require('extract-zip');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Persistent Data Directory ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ---------- B2 Client Setup ----------
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_REGION = process.env.B2_REGION || "us-west-004";
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

let b2Client = null;
if (B2_ENDPOINT && B2_KEY_ID && B2_APP_KEY && B2_BUCKET_NAME) {
  b2Client = new S3Client({
    endpoint: B2_ENDPOINT,
    region: B2_REGION,
    credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
    forcePathStyle: true,
  });
  console.log('✅ B2 client initialized');
} else {
  console.warn('⚠️ B2 credentials missing – uploads will FAIL');
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

// ---------- JSON Helpers ----------
const dbFile = name => path.join(DATA_DIR, `${name}.json`);
function readDB(name, def = []) {
  try { return JSON.parse(fs.readFileSync(dbFile(name), 'utf8')); }
  catch { return def; }
}
function writeDB(name, data) {
  fs.writeFileSync(dbFile(name), JSON.stringify(data, null, 2));
}

// Initialize defaults
if (!fs.existsSync(dbFile('settings'))) {
  writeDB('settings', {
    adminPassword: process.env.ADMIN_PASSWORD || '0726019859',
    term1Enabled: true, term2Enabled: true, term3Enabled: true,
    defaultTerm: '1',
    bannerEnabled: false, bannerText: '',
    waEnabled: false, waNumber: '', waMessage: 'Hello'
  });
}
['schemes', 'areas', 'visitors', 'sales', 'popups', 'grades', 'stats', 'resetCodes'].forEach(n => {
  if (!fs.existsSync(dbFile(n))) writeDB(n, []);
});

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

// Admin auth
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const settings = readDB('settings', {});
  if (!token || token !== settings.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Stats helper
function incStat(key) {
  const stats = readDB('stats', { visits: 0, downloads: 0, sales: 0 });
  stats[key] = (stats[key] || 0) + 1;
  writeDB('stats', stats);
}

// Active users tracking
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

// Payment state
const transactions = {};
const verificationTokens = {};
const downloadTokens = {};

const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || '';
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';
const DEMO_MODE = !PAYNECTA_API_KEY;
if (DEMO_MODE) console.log('⚠️ DEMO MODE – payments auto‑confirm after 10s');

// ---------- PUBLIC ROUTES ----------
app.get('/health', (req, res) => res.json({ status: 'ok', demo: DEMO_MODE }));

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
  res.json(schemes);
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

// Payment endpoints (initiate, status, request-download, download) unchanged but working

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
  if (!mobile) return res.status(400).json({ error: 'Invalid phone' });
  const transactionId = crypto.randomBytes(10).toString('hex');
  if (DEMO_MODE) {
    transactions[transactionId] = { status: 'pending', productId, phone: mobile };
    setTimeout(() => {
      if (transactions[transactionId]) {
        const vt = crypto.randomBytes(16).toString('hex');
        verificationTokens[vt] = { productId, expiresAt: Date.now() + 5*60*1000 };
        transactions[transactionId] = { status: 'success', productId, verificationToken: vt };
      }
    }, 10000);
    return res.json({ transactionId, demo: true });
  }
  // Real Paynecta call
  try {
    const response = await fetch(`${PAYNECTA_API_URL}/payment/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL },
      body: JSON.stringify({ code: PAYNECTA_PAYMENT_CODE, mobile_number: mobile, amount: Number(amount || scheme.price) })
    });
    const data = await response.json();
    const ref = data.transaction_reference || data.data?.transaction_reference;
    if (!ref) throw new Error('No transaction reference');
    transactions[transactionId] = { transactionRef: ref, productId, status: 'pending', phone: mobile };
    res.json({ transactionId });
  } catch (err) {
    res.status(502).json({ error: 'Payment gateway error' });
  }
});

app.get('/api/payment-status/:transactionId', async (req, res) => {
  const tx = transactions[req.params.transactionId];
  if (!tx) return res.status(404).json({ status: 'not_found' });
  if (tx.status === 'success') return res.json({ status: 'success', verificationToken: tx.verificationToken });
  if (tx.status === 'failed') return res.json({ status: 'failed', message: tx.failReason });
  if (DEMO_MODE) return res.json({ status: 'pending' });
  try {
    const response = await fetch(`${PAYNECTA_API_URL}/payment/status?transaction_reference=${tx.transactionRef}`, {
      headers: { 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL }
    });
    const data = await response.json();
    const inner = data.data || data;
    if (inner.status === 'completed' && inner.result_code === 0) {
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { productId: tx.productId, expiresAt: Date.now() + 5*60*1000 };
      transactions[req.params.transactionId] = { ...tx, status: 'success', verificationToken: vt };
      const sales = readDB('sales');
      const scheme = readDB('schemes').find(s => s.id === tx.productId);
      sales.push({ title: scheme?.title, phone: tx.phone, amount: scheme?.price, date: new Date().toISOString() });
      writeDB('sales', sales);
      incStat('sales');
      return res.json({ status: 'success', verificationToken: vt });
    }
    if (['failed', 'cancelled'].includes(inner.status)) {
      transactions[req.params.transactionId].status = 'failed';
      return res.json({ status: 'failed', message: inner.result_description });
    }
    res.json({ status: 'pending' });
  } catch { res.json({ status: 'pending' }); }
});

app.post('/api/request-download', (req, res) => {
  const { verificationToken, productId } = req.body;
  const vt = verificationTokens[verificationToken];
  if (!vt || vt.productId !== productId || Date.now() > vt.expiresAt) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const scheme = readDB('schemes').find(s => s.id === productId);
  if (!scheme || !scheme.fileKey) return res.status(404).json({ error: 'File not found' });
  const dt = crypto.randomBytes(16).toString('hex');
  downloadTokens[dt] = { key: scheme.fileKey, fileName: scheme.originalName, expiresAt: Date.now() + 2*60*1000 };
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
  const settings = readDB('settings', {});
  if (req.body.password === settings.adminPassword) {
    res.json({ token: settings.adminPassword, ok: true });
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
    const { title, subject, grade, term, price, weeks, pages, visible } = req.body;
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
      coverKey, visible: visible !== 'false', createdAt: new Date().toISOString()
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
  const { price, weeks, visible } = req.body;
  if (price !== undefined) schemes[idx].price = Number(price);
  if (weeks !== undefined) schemes[idx].weeks = Number(weeks) || null;
  if (visible !== undefined) schemes[idx].visible = Boolean(visible);
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

app.get('/api/admin/subjects', adminAuth, (req, res) => res.json(readDB('areas')));
app.post('/api/admin/subjects', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const areas = readDB('areas');
  if (areas.find(a => a.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Exists' });
  areas.push({ id: crypto.randomUUID(), name: name.trim() });
  writeDB('areas', areas);
  res.status(201).json({ ok: true });
});
app.delete('/api/admin/subjects/:id', adminAuth, (req, res) => {
  writeDB('areas', readDB('areas').filter(a => a.id !== req.params.id));
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
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const grades = readDB('grades');
  grades.push({ id: crypto.randomUUID(), name: name.trim(), active: true });
  writeDB('grades', grades);
  res.status(201).json({ ok: true });
});
app.delete('/api/admin/grades/:id', adminAuth, (req, res) => {
  writeDB('grades', readDB('grades').filter(g => g.id !== req.params.id));
  res.json({ ok: true });
});

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

app.get('/api/admin/popups', adminAuth, (req, res) => res.json(readDB('popups')));
app.post('/api/admin/popups', adminAuth, (req, res) => {
  const { question, options, trigger, collectWhatsapp } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const popups = readDB('popups');
  popups.push({ id: crypto.randomUUID(), question, options, trigger: trigger || 'onload', collectWhatsapp: !!collectWhatsapp });
  writeDB('popups', popups);
  res.status(201).json({ ok: true });
});

app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Too short' });
  const s = readDB('settings', {});
  s.adminPassword = newPassword;
  writeDB('settings', s);
  res.json({ ok: true });
});

app.get('/api/admin/backup', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="backup-${Date.now()}.zip"`);
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

// Password reset (email) – simplified
app.post('/api/admin/forgot-password', async (req, res) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const resetCodes = readDB('resetCodes', {});
  resetCodes['admin'] = { code, expires: Date.now() + 15*60*1000 };
  writeDB('resetCodes', resetCodes);
  // In production, send email via nodemailer
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

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
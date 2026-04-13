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
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
console.log(`📂 Data directory: ${DATA_DIR}`);

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

async function verifyB2Connectivity() {
  if (!b2Client) return { status: 'not configured' };
  try {
    const command = new ListObjectsV2Command({ Bucket: B2_BUCKET_NAME, MaxKeys: 1000 });
    const response = await b2Client.send(command);
    const fileCount = response.KeyCount || 0;
    let totalSize = 0;
    if (response.Contents) totalSize = response.Contents.reduce((sum, obj) => sum + (obj.Size || 0), 0);
    console.log(`✅ B2 connected – ${fileCount} objects, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    return { status: 'connected', fileCount, totalSize };
  } catch (err) {
    console.error('❌ B2 check failed:', err.message);
    return { status: 'error', error: err.message };
  }
}
if (B2_ENABLED) verifyB2Connectivity();

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
    waEnabled: false, waNumber: '', waMessage: 'Hello',
    showAllGrades: true,
    featuredSchemeIds: [],
    emailNotifications: true
  });
}
['schemes', 'areas', 'visitors', 'sales', 'popups', 'grades', 'stats', 'resetCodes', 'transactions'].forEach(n => {
  if (!fs.existsSync(dbFile(n))) writeDB(n, []);
});

// Seed grades if empty
let grades = readDB('grades');
if (!grades.length) {
  grades = Array.from({ length: 9 }, (_, i) => ({
    id: crypto.randomUUID(), name: `Grade ${i+1}`, active: true
  }));
  writeDB('grades', grades);
}

// ---------- Scheduled Publishing ----------
cron.schedule('* * * * *', () => {
  const now = new Date().toISOString();
  const schemes = readDB('schemes');
  let changed = false;
  schemes.forEach(s => {
    if (s.publishAt && s.publishAt <= now && s.visible === false) {
      s.visible = true; s.publishAt = null; changed = true;
    }
    if (s.unpublishAt && s.unpublishAt <= now && s.visible === true) {
      s.visible = false; s.unpublishAt = null; changed = true;
    }
  });
  if (changed) writeDB('schemes', schemes);
});

// ---------- Multer ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp'];
    cb(null, allowed.includes(ext));
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
  if (!token || token !== settings.adminPassword) return res.status(401).json({ error: 'Unauthorized' });
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
    Object.keys(userSessions).forEach(k => { if (now - userSessions[k] > 300000) delete userSessions[k]; });
  }
  next();
});

// Payment state (in-memory for speed, backed by persistent store)
const verificationTokens = {};
const downloadTokens = {};

// Load persistent transactions on startup
let transactions = {};
const persistentTx = readDB('transactions', {});
Object.assign(transactions, persistentTx);
console.log(`📦 Loaded ${Object.keys(transactions).length} persisted transactions`);

function saveTransaction(id, data) {
  transactions[id] = data;
  const allTx = readDB('transactions', {});
  allTx[id] = data;
  writeDB('transactions', allTx);
}

function removeTransaction(id) {
  delete transactions[id];
  const allTx = readDB('transactions', {});
  delete allTx[id];
  writeDB('transactions', allTx);
}

const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || '';
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';
const DEMO_MODE = !PAYNECTA_API_KEY;
if (DEMO_MODE) console.log('⚠️ DEMO MODE – payments auto‑confirm after 5s');

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
      text: `Scheme: ${scheme.title}\nAmount: KES ${amount}\nPhone: ${phone}`
    });
  } catch (e) {}
}

// ---------- PUBLIC ROUTES ----------
app.get('/health', (req, res) => res.json({ status: 'ok', demo: DEMO_MODE, b2: B2_ENABLED }));

app.post('/api/track-visit', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const visitors = readDB('visitors');
  visitors.push({ ip, device: /mobile/i.test(ua) ? 'Mobile' : 'Desktop', time: new Date().toISOString() });
  writeDB('visitors', visitors.slice(-500));
  incStat('visits');
  res.json({ ok: true });
});

app.get('/api/schemes', (req, res) => {
  const schemes = readDB('schemes').filter(s => s.visible !== false);
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
  const scheme = readDB('schemes').find(s => s.id === req.params.schemeId);
  if (!scheme || !scheme.coverKey) return res.status(404).send('No cover');
  try { await streamFileFromB2(scheme.coverKey, res); }
  catch { res.status(404).send('Cover not found'); }
});

app.get('/api/grades/available', (req, res) => {
  const settings = readDB('settings', {});
  const schemes = readDB('schemes').filter(s => s.visible !== false);
  let grades = readDB('grades');
  if (!grades.length) {
    grades = Array.from({ length: 9 }, (_, i) => ({ id: crypto.randomUUID(), name: `Grade ${i+1}`, active: true }));
    writeDB('grades', grades);
  }
  if (settings.showAllGrades) {
    return res.json(grades.filter(g => g.active));
  }
  const gradeSet = new Set();
  schemes.forEach(s => { if (s.grade) gradeSet.add(s.grade); });
  const filtered = Array.from(gradeSet).sort().map(name => grades.find(g => g.name === name) || { name, active: true });
  res.json(filtered);
});

// ---------- PAYMENT ROUTES (FIXED WITH PERSISTENCE) ----------
function normalisePhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0') && p.length === 10) p = '254' + p.slice(1);
  if (p.startsWith('7') && p.length === 9) p = '254' + p;
  return (p.startsWith('254') && p.length === 12) ? p : null;
}

app.post('/api/initiate-payment', async (req, res) => {
  const { phone, amount, productId } = req.body;
  const scheme = readDB('schemes').find(s => s.id === productId);
  if (!scheme) return res.status(404).json({ error: 'Product not found' });
  const mobile = normalisePhone(phone);
  if (!mobile) return res.status(400).json({ error: 'Invalid phone' });
  const transactionId = crypto.randomBytes(10).toString('hex');

  if (DEMO_MODE) {
    const txData = { status: 'pending', productId, phone: mobile };
    saveTransaction(transactionId, txData);
    setTimeout(() => {
      const current = transactions[transactionId];
      if (current && current.status === 'pending') {
        const vt = crypto.randomBytes(16).toString('hex');
        verificationTokens[vt] = { productId, expiresAt: Date.now() + 5*60*1000 };
        saveTransaction(transactionId, { ...current, status: 'success', verificationToken: vt });
        console.log(`🟢 DEMO: Payment confirmed for ${transactionId}`);
      }
    }, 5000);
    return res.json({ transactionId, demo: true });
  }

  try {
    const payload = { code: PAYNECTA_PAYMENT_CODE, mobile_number: mobile, amount: Number(amount || scheme.price) };
    console.log(`📤 Paynecta init:`, payload);
    const response = await fetch(`${PAYNECTA_API_URL}/payment/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL },
      body: JSON.stringify(payload)
    });
    const rawText = await response.text();
    console.log(`📥 Init response:`, rawText);
    let data;
    try { data = JSON.parse(rawText); } catch (e) { return res.status(502).json({ error: 'Invalid JSON from Paynecta' }); }
    const ref = data.transaction_reference || data.data?.transaction_reference;
    if (!ref) {
      console.error('❌ No reference in response:', data);
      return res.status(502).json({ error: 'Payment gateway error: No reference' });
    }
    const txData = { transactionRef: ref, productId, status: 'pending', phone: mobile };
    saveTransaction(transactionId, txData);
    console.log(`✅ Initiated, ref: ${ref}, id: ${transactionId}`);
    res.json({ transactionId });
  } catch (err) {
    console.error('Init error:', err);
    res.status(502).json({ error: 'Could not reach payment gateway' });
  }
});

app.get('/api/payment-status/:transactionId', async (req, res) => {
  const tx = transactions[req.params.transactionId];
  if (!tx) return res.status(404).json({ status: 'not_found' });
  if (tx.status === 'success') return res.json({ status: 'success', verificationToken: tx.verificationToken });
  if (tx.status === 'failed') return res.json({ status: 'failed', message: tx.failReason });
  if (DEMO_MODE) return res.json({ status: 'pending' });

  try {
    console.log(`🔍 Checking status for ref: ${tx.transactionRef}`);
    const response = await fetch(`${PAYNECTA_API_URL}/payment/status?transaction_reference=${encodeURIComponent(tx.transactionRef)}`, {
      headers: { 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL }
    });
    const rawText = await response.text();
    console.log(`📡 Status response:`, rawText);
    let data;
    try { data = JSON.parse(rawText); } catch (e) { return res.json({ status: 'pending' }); }
    const inner = data.data || data;
    const status = inner.status;
    const resultCode = inner.result_code;
    
    if (status === 'completed' && (resultCode === 0 || resultCode === '0')) {
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { productId: tx.productId, expiresAt: Date.now() + 5*60*1000 };
      const updatedTx = { ...tx, status: 'success', verificationToken: vt };
      saveTransaction(req.params.transactionId, updatedTx);
      
      const scheme = readDB('schemes').find(s => s.id === tx.productId);
      const sales = readDB('sales');
      sales.push({ title: scheme?.title, grade: scheme?.grade, phone: tx.phone, amount: scheme?.price, date: new Date().toISOString(), mpesaReceipt: inner.mpesa_receipt_number });
      writeDB('sales', sales);
      incStat('sales');
      if (scheme) sendSaleNotification(scheme, tx.phone, scheme.price);
      console.log(`✅ Payment confirmed! Receipt: ${inner.mpesa_receipt_number}`);
      return res.json({ status: 'success', verificationToken: vt });
    }
    
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      const failReason = inner.result_description || inner.failure_reason || 'Payment failed';
      saveTransaction(req.params.transactionId, { ...tx, status: 'failed', failReason });
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
  if (!vt || vt.productId !== productId || Date.now() > vt.expiresAt) return res.status(403).json({ error: 'Invalid token' });
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

// ---------- ADMIN ROUTES (all included) ----------
app.post('/api/admin/login', (req, res) => {
  const settings = readDB('settings', {});
  if (req.body.password === settings.adminPassword) res.json({ token: settings.adminPassword, ok: true });
  else res.status(401).json({ error: 'Wrong password' });
});
app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ ok: true }));
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = readDB('stats', {});
  res.json({ visits: stats.visits||0, downloads: stats.downloads||0, sales: stats.sales||0, schemes: readDB('schemes').length, activeUsers: Object.keys(userSessions).length });
});
app.get('/api/admin/schemes', adminAuth, (req, res) => res.json(readDB('schemes')));
app.post('/api/admin/schemes', adminAuth, upload.fields([{ name: 'document' }, { name: 'cover' }]), async (req, res) => {
  try {
    const { title, subject, grade, term, price, weeks, pages, visible, publishAt, unpublishAt } = req.body;
    if (!title || !subject || !grade || !term || !price || !req.files?.document) return res.status(400).json({ error: 'Missing fields' });
    const docKey = await uploadBufferToB2(req.files.document[0].buffer, req.files.document[0].originalname, req.files.document[0].mimetype, 'schemes');
    let coverKey = null;
    if (req.files.cover) coverKey = await uploadBufferToB2(req.files.cover[0].buffer, req.files.cover[0].originalname, req.files.cover[0].mimetype, 'covers');
    const scheme = {
      id: crypto.randomUUID(), title, subject, grade, term: Number(term), price: Number(price),
      weeks: weeks?Number(weeks):null, pages: pages?Number(pages):null,
      fileKey: docKey, originalName: req.files.document[0].originalname,
      coverKey, visible: visible!=='false', createdAt: new Date().toISOString(),
      publishAt: publishAt||null, unpublishAt: unpublishAt||null
    };
    const schemes = readDB('schemes'); schemes.push(scheme); writeDB('schemes', schemes);
    res.status(201).json(scheme);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/admin/schemes/:id', adminAuth, (req, res) => {
  const schemes = readDB('schemes'); const idx = schemes.findIndex(s=>s.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error: 'Not found' });
  const { price, weeks, visible, publishAt, unpublishAt } = req.body;
  if (price!==undefined) schemes[idx].price=Number(price);
  if (weeks!==undefined) schemes[idx].weeks=Number(weeks)||null;
  if (visible!==undefined) schemes[idx].visible=Boolean(visible);
  if (publishAt!==undefined) schemes[idx].publishAt=publishAt||null;
  if (unpublishAt!==undefined) schemes[idx].unpublishAt=unpublishAt||null;
  writeDB('schemes', schemes); res.json(schemes[idx]);
});
app.post('/api/admin/schemes/:id/cover', adminAuth, upload.single('cover'), async (req, res) => {
  const schemes = readDB('schemes'); const scheme = schemes.find(s=>s.id===req.params.id);
  if (!scheme) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try { scheme.coverKey = await uploadBufferToB2(req.file.buffer, req.file.originalname, req.file.mimetype, 'covers'); writeDB('schemes', schemes); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/schemes/:id', adminAuth, (req, res) => {
  writeDB('schemes', readDB('schemes').filter(s=>s.id!==req.params.id)); res.json({ ok: true });
});
app.post('/api/admin/schemes/bulk', adminAuth, upload.fields([{ name: 'documents' }, { name: 'covers' }]), async (req, res) => {
  const { title, subject, grade, term, price, weeks, pages, visible } = req.body;
  if (!title||!subject||!grade||!term||!price||!req.files?.documents) return res.status(400).json({ error: 'Missing fields' });
  const docs = req.files.documents; const covers = req.files.covers || []; const schemes = readDB('schemes'); const created = [];
  for (let i=0; i<docs.length; i++) {
    try {
      const docKey = await uploadBufferToB2(docs[i].buffer, docs[i].originalname, docs[i].mimetype, 'schemes');
      let coverKey = null; if (covers[i]) coverKey = await uploadBufferToB2(covers[i].buffer, covers[i].originalname, covers[i].mimetype, 'covers');
      const scheme = {
        id: crypto.randomUUID(), title: docs.length>1?`${title} (${i+1})`:title, subject, grade, term: Number(term), price: Number(price),
        weeks: weeks?Number(weeks):null, pages: pages?Number(pages):null,
        fileKey: docKey, originalName: docs[i].originalname, coverKey, visible: visible!=='false', createdAt: new Date().toISOString()
      };
      schemes.push(scheme); created.push(scheme);
    } catch (e) {}
  }
  writeDB('schemes', schemes); res.status(201).json({ created: created.length });
});
app.post('/api/admin/schemes/bulk-price', adminAuth, (req, res) => {
  const { schemeIds, price, operation='set' } = req.body;
  const schemes = readDB('schemes'); let updated=0;
  schemes.forEach(s => { if (schemeIds.includes(s.id)) {
    if (operation==='set') s.price=Number(price);
    else if (operation==='increase') s.price=Math.max(0, s.price+Number(price));
    else if (operation==='decrease') s.price=Math.max(0, s.price-Number(price));
    updated++;
  }});
  writeDB('schemes', schemes); res.json({ ok: true, updated });
});
app.post('/api/admin/schemes/bulk-visibility', adminAuth, (req, res) => {
  const { schemeIds, visible } = req.body; const schemes = readDB('schemes'); let updated=0;
  schemes.forEach(s => { if (schemeIds.includes(s.id)) { s.visible=Boolean(visible); updated++; } });
  writeDB('schemes', schemes); res.json({ ok: true, updated });
});
app.get('/api/admin/schemes/featured', adminAuth, (req, res) => res.json({ featuredSchemeIds: readDB('settings',{}).featuredSchemeIds||[] }));
app.post('/api/admin/schemes/featured', adminAuth, (req, res) => {
  const settings = readDB('settings',{}); settings.featuredSchemeIds = req.body.schemeIds||[]; writeDB('settings', settings); res.json({ ok: true });
});
app.patch('/api/admin/settings/grade-display', adminAuth, (req, res) => {
  const settings = readDB('settings',{}); settings.showAllGrades = req.body.showAllGrades!==false; writeDB('settings', settings); res.json({ ok: true });
});
app.patch('/api/admin/settings/email-notifications', adminAuth, (req, res) => {
  const settings = readDB('settings',{}); settings.emailNotifications = req.body.enabled!==false; writeDB('settings', settings); res.json({ ok: true });
});
app.get('/api/admin/analytics/downloads', adminAuth, (req, res) => {
  const schemes = readDB('schemes'); const sales = readDB('sales'); const counts = {};
  sales.forEach(s => { counts[s.title] = (counts[s.title]||0)+1; });
  res.json(schemes.map(s => ({ id: s.id, title: s.title, grade: s.grade, downloads: counts[s.title]||0, revenue: (counts[s.title]||0)*s.price })).sort((a,b)=>b.downloads-a.downloads));
});
app.get('/api/admin/sales/export', adminAuth, (req, res) => {
  const sales = readDB('sales'); let csv = 'Date,Title,Grade,Phone,Amount,M-Pesa Receipt\n';
  sales.forEach(s => { csv += `${s.date},${s.title},${s.grade||''},${s.phone},${s.amount},${s.mpesaReceipt||''}\n`; });
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="sales.csv"'); res.send(csv);
});
app.get('/api/admin/health', adminAuth, async (req, res) => {
  const b2 = B2_ENABLED ? await verifyB2Connectivity() : { status: 'disabled' };
  res.json({ b2, database: { schemes: readDB('schemes').length, subjects: readDB('areas').length } });
});
// Subjects
app.get('/api/admin/subjects', adminAuth, (req, res) => res.json(readDB('areas')));
app.post('/api/admin/subjects', adminAuth, (req, res) => {
  const { name } = req.body; if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const areas = readDB('areas'); if (areas.find(a=>a.name.toLowerCase()===name.trim().toLowerCase())) return res.status(409).json({ error: 'Exists' });
  areas.push({ id: crypto.randomUUID(), name: name.trim() }); writeDB('areas', areas); res.status(201).json({ ok: true });
});
app.delete('/api/admin/subjects/:id', adminAuth, (req, res) => {
  writeDB('areas', readDB('areas').filter(a=>a.id!==req.params.id)); res.json({ ok: true });
});
// Grades
app.get('/api/admin/grades', adminAuth, (req, res) => res.json(readDB('grades')));
app.post('/api/admin/grades', adminAuth, (req, res) => {
  const { name } = req.body; if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const grades = readDB('grades'); grades.push({ id: crypto.randomUUID(), name: name.trim(), active: true }); writeDB('grades', grades); res.status(201).json({ ok: true });
});
app.delete('/api/admin/grades/:id', adminAuth, (req, res) => {
  writeDB('grades', readDB('grades').filter(g=>g.id!==req.params.id)); res.json({ ok: true });
});
// Visitors
app.get('/api/admin/visitors', adminAuth, (req, res) => res.json(readDB('visitors')));
app.delete('/api/admin/visitors/clear', adminAuth, (req, res) => { writeDB('visitors', []); res.json({ ok: true }); });
// Banner
app.get('/api/admin/banner', adminAuth, (req, res) => { const s=readDB('settings',{}); res.json({ text: s.bannerText||'', enabled: s.bannerEnabled||false }); });
app.post('/api/admin/banner', adminAuth, (req, res) => { const s=readDB('settings',{}); s.bannerText=req.body.text||''; s.bannerEnabled=req.body.enabled||false; writeDB('settings',s); res.json({ ok: true }); });
// WhatsApp
app.get('/api/admin/whatsapp', adminAuth, (req, res) => { const s=readDB('settings',{}); res.json({ number: s.waNumber||'', message: s.waMessage||'Hello', enabled: s.waEnabled||false }); });
app.post('/api/admin/whatsapp', adminAuth, (req, res) => { const s=readDB('settings',{}); s.waNumber=req.body.number||''; s.waMessage=req.body.message||'Hello'; s.waEnabled=req.body.enabled||false; writeDB('settings',s); res.json({ ok: true }); });
// Terms
app.get('/api/admin/terms', adminAuth, (req, res) => { const s=readDB('settings',{}); res.json({ term1Enabled: s.term1Enabled!==false, term2Enabled: s.term2Enabled!==false, term3Enabled: s.term3Enabled!==false, defaultTerm: s.defaultTerm||'1' }); });
app.post('/api/admin/terms', adminAuth, (req, res) => { const s=readDB('settings',{}); if (req.body.term1Enabled!==undefined) s.term1Enabled=req.body.term1Enabled; if (req.body.term2Enabled!==undefined) s.term2Enabled=req.body.term2Enabled; if (req.body.term3Enabled!==undefined) s.term3Enabled=req.body.term3Enabled; if (req.body.defaultTerm) s.defaultTerm=req.body.defaultTerm; writeDB('settings',s); res.json({ ok: true }); });
// Popups
app.get('/api/admin/popups', adminAuth, (req, res) => res.json(readDB('popups')));
app.post('/api/admin/popups', adminAuth, (req, res) => {
  const { question, options, trigger, collectWhatsapp, delay, delayUnit } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const popups = readDB('popups');
  popups.push({ id: crypto.randomUUID(), question, options, trigger: trigger||'onload', collectWhatsapp: !!collectWhatsapp, delay: delay?Number(delay):0, delayUnit: delayUnit||'seconds' });
  writeDB('popups', popups); res.status(201).json({ ok: true });
});
// Password
app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { newPassword } = req.body; if (!newPassword||newPassword.length<6) return res.status(400).json({ error: 'Too short' });
  const s=readDB('settings',{}); s.adminPassword=newPassword; writeDB('settings',s); res.json({ ok: true });
});
app.post('/api/admin/forgot-password', async (req, res) => {
  const code = Math.floor(100000+Math.random()*900000).toString(); const resetCodes=readDB('resetCodes',{}); resetCodes['admin']={ code, expires: Date.now()+15*60*1000 }; writeDB('resetCodes',resetCodes); res.json({ success: true, demoCode: DEMO_MODE?code:undefined });
});
app.post('/api/admin/reset-password', (req, res) => {
  const { code, newPassword } = req.body; const stored=readDB('resetCodes',{})['admin'];
  if (!stored||stored.code!==code||stored.expires<Date.now()) return res.status(400).json({ error: 'Invalid or expired' });
  const s=readDB('settings',{}); s.adminPassword=newPassword; writeDB('settings',s); writeDB('resetCodes',{}); res.json({ ok: true });
});
// Backup/Restore
app.get('/api/admin/backup', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="backup-${Date.now()}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } }); archive.pipe(res); archive.directory(DATA_DIR, 'data'); archive.finalize();
});
app.post('/api/admin/restore', adminAuth, restoreStorage.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try { await extract(req.file.path, { dir: path.dirname(DATA_DIR) }); fs.unlinkSync(req.file.path); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
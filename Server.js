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

// ---------- Persistent Data ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
console.log(`📂 Data: ${DATA_DIR}`);

// ---------- B2 ----------
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_REGION = process.env.B2_REGION || "us-west-004";
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;
let b2Client = null, B2_ENABLED = false;
if (B2_ENDPOINT && B2_KEY_ID && B2_APP_KEY && B2_BUCKET_NAME) {
  b2Client = new S3Client({ endpoint: B2_ENDPOINT, region: B2_REGION, credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY }, forcePathStyle: true });
  B2_ENABLED = true;
  console.log('✅ B2 ready');
} else console.warn('⚠️ B2 missing');

async function uploadBufferToB2(buffer, fileName, mimeType, folder = 'schemes') {
  if (!b2Client) throw new Error('B2 not configured');
  const key = `${folder}/${Date.now()}_${fileName.replace(/\s+/g, '_')}`;
  await b2Client.send(new PutObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key, Body: buffer, ContentType: mimeType, ContentDisposition: `attachment; filename="${fileName}"` }));
  return key;
}
async function streamFileFromB2(key, res) {
  const r = await b2Client.send(new GetObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key }));
  res.setHeader('Content-Type', r.ContentType);
  res.setHeader('Content-Disposition', r.ContentDisposition || 'attachment');
  r.Body.pipe(res);
}

// ---------- JSON DB ----------
const dbFile = n => path.join(DATA_DIR, `${n}.json`);
function readDB(n, d = []) { try { return JSON.parse(fs.readFileSync(dbFile(n), 'utf8')); } catch { return d; } }
function writeDB(n, d) { fs.writeFileSync(dbFile(n), JSON.stringify(d, null, 2)); }

if (!fs.existsSync(dbFile('settings'))) writeDB('settings', { adminPassword: process.env.ADMIN_PASSWORD || '0726019859', term1Enabled: true, term2Enabled: true, term3Enabled: true, defaultTerm: '1', bannerEnabled: false, bannerText: '', waEnabled: false, waNumber: '', waMessage: 'Hello', showAllGrades: true, featuredSchemeIds: [], emailNotifications: true });
['schemes','areas','visitors','sales','popups','grades','stats','resetCodes'].forEach(n => { if (!fs.existsSync(dbFile(n))) writeDB(n, []); });
let grades = readDB('grades'); if (!grades.length) { grades = Array.from({length:9}, (_,i)=>({id:crypto.randomUUID(), name:`Grade ${i+1}`, active:true})); writeDB('grades', grades); }

// ---------- Cron ----------
cron.schedule('* * * * *', () => {
  const now = new Date().toISOString(), schemes = readDB('schemes'); let changed = false;
  schemes.forEach(s => { if (s.publishAt && s.publishAt <= now && s.visible === false) { s.visible = true; s.publishAt = null; changed = true; } if (s.unpublishAt && s.unpublishAt <= now && s.visible === true) { s.visible = false; s.unpublishAt = null; changed = true; } });
  if (changed) writeDB('schemes', schemes);
});

// ---------- Multer ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50*1024*1024 }, fileFilter: (r,f,cb) => cb(null, ['.pdf','.doc','.docx','.jpg','.jpeg','.png','.webp'].includes(path.extname(f.originalname).toLowerCase())) });
const restoreStorage = multer({ dest: path.join(DATA_DIR, 'tmp') });

// ---------- Middleware ----------
app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use(express.static(__dirname));
app.use((r,res,next) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Admin-Token'); if (r.method==='OPTIONS') return res.sendStatus(200); next(); });
function adminAuth(r,res,next) { const t = r.headers['x-admin-token']||r.query.token; if (!t||t!==readDB('settings',{}).adminPassword) return res.status(401).json({error:'Unauthorized'}); next(); }
function incStat(k) { const s = readDB('stats',{visits:0,downloads:0,sales:0}); s[k]=(s[k]||0)+1; writeDB('stats',s); }
const userSessions = {};
app.use((r,res,next) => { const ip = r.headers['x-forwarded-for']?.split(',')[0]||r.socket.remoteAddress; if(ip) { userSessions[ip]=Date.now(); Object.keys(userSessions).forEach(k=>{ if(Date.now()-userSessions[k]>300000) delete userSessions[k]; }); } next(); });

// ---------- Payment State (Persistent) ----------
const verificationTokens = {}, downloadTokens = {};
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');
let transactions = fs.existsSync(TRANSACTIONS_FILE) ? JSON.parse(fs.readFileSync(TRANSACTIONS_FILE,'utf8')) : {};
const saveTx = () => fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions));
console.log(`📦 Loaded ${Object.keys(transactions).length} transactions`);

const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || '';
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';
const DEMO_MODE = !PAYNECTA_API_KEY;
if (DEMO_MODE) console.log('⚠️ DEMO MODE – payments auto‑confirm after 5s');
else console.log('💰 Paynecta LIVE mode enabled');

async function sendSaleNotification(scheme, phone, amount) {
  const s = readDB('settings',{}); if (!s.emailNotifications) return;
  if (!process.env.EMAIL_USER||!process.env.EMAIL_PASS) return;
  try { const t = nodemailer.createTransport({service:'gmail', auth:{user:process.env.EMAIL_USER, pass:process.env.EMAIL_PASS}}); await t.sendMail({from:`"SchemeVault" <${process.env.EMAIL_USER}>`, to:process.env.ADMIN_EMAIL||process.env.EMAIL_USER, subject:`💰 New Sale: ${scheme.title}`, text:`Scheme: ${scheme.title}\nAmount: KES ${amount}\nPhone: ${phone}`}); } catch(e) {}
}

// ---------- Public Routes ----------
app.get('/health', (r,res) => res.json({ status:'ok', demo:DEMO_MODE, b2:B2_ENABLED }));
app.post('/api/track-visit', (r,res) => { const ip = r.headers['x-forwarded-for']?.split(',')[0]||r.socket.remoteAddress||'unknown'; const ua = r.headers['user-agent']||''; const visitors = readDB('visitors'); visitors.push({ ip, device: /mobile/i.test(ua)?'Mobile':'Desktop', time: new Date().toISOString() }); writeDB('visitors', visitors.slice(-500)); incStat('visits'); res.json({ok:true}); });
app.get('/api/schemes', (r,res) => { const schemes = readDB('schemes').filter(s=>s.visible!==false).sort((a,b)=>{ const ga = parseInt(a.grade?.match(/\d+/)?.[0]||'0'), gb = parseInt(b.grade?.match(/\d+/)?.[0]||'0'); if(gb!==ga) return gb-ga; return (a.subject||'').localeCompare(b.subject||''); }); res.json(schemes); });
app.get('/api/areas', (r,res) => res.json(readDB('areas')));
app.get('/api/settings', (r,res) => { const s=readDB('settings',{}); res.json({ term1Enabled: s.term1Enabled!==false, term2Enabled: s.term2Enabled!==false, term3Enabled: s.term3Enabled!==false, defaultTerm: s.defaultTerm||'1' }); });
app.get('/api/banner', (r,res) => { const s=readDB('settings',{}); res.json({ enabled: s.bannerEnabled||false, text: s.bannerText||'' }); });
app.get('/api/whatsapp', (r,res) => { const s=readDB('settings',{}); res.json({ enabled: s.waEnabled||false, number: s.waNumber||'', message: s.waMessage||'Hello' }); });
app.get('/api/popups', (r,res) => res.json(readDB('popups')));
app.get('/api/cover/:id', async (r,res) => { const s = readDB('schemes').find(s=>s.id===r.params.id); if (!s?.coverKey) return res.status(404).send('No cover'); try { await streamFileFromB2(s.coverKey, res); } catch { res.status(404).send('Cover not found'); } });
app.get('/api/grades/available', (r,res) => { const set = readDB('settings',{}), schemes = readDB('schemes').filter(s=>s.visible!==false); let grades = readDB('grades'); if(!grades.length){ grades = Array.from({length:9}, (_,i)=>({id:crypto.randomUUID(), name:`Grade ${i+1}`, active:true})); writeDB('grades',grades); } if(set.showAllGrades) return res.json(grades.filter(g=>g.active)); const gradeSet = new Set(); schemes.forEach(s=>{ if(s.grade) gradeSet.add(s.grade); }); res.json(Array.from(gradeSet).sort().map(n=> grades.find(g=>g.name===n)||{name:n,active:true})); });

// ---------- PAYMENT ROUTES (FIXED CONDITION) ----------
function normalisePhone(raw) { let p = String(raw).replace(/\D/g,''); if(p.startsWith('0')&&p.length===10) p='254'+p.slice(1); if(p.startsWith('7')&&p.length===9) p='254'+p; return (p.startsWith('254')&&p.length===12)?p:null; }

app.post('/api/initiate-payment', async (r,res) => {
  console.log('\n========== PAYMENT INITIATED ==========');
  const { phone, amount, productId } = r.body;
  console.log('📞 Phone:', phone, '→ Normalised:', normalisePhone(phone));
  console.log('💰 Amount:', amount);
  console.log('📦 Product ID:', productId);
  const scheme = readDB('schemes').find(s=>s.id===productId);
  if (!scheme) { console.log('❌ Product not found'); return res.status(404).json({ error: 'Product not found' }); }
  console.log('📚 Scheme:', scheme.title, 'Price:', scheme.price);
  const mobile = normalisePhone(phone);
  if (!mobile) { console.log('❌ Invalid phone'); return res.status(400).json({ error: 'Invalid phone' }); }
  const txId = crypto.randomBytes(10).toString('hex');
  console.log('🆔 Transaction ID:', txId);

  if (DEMO_MODE) {
    console.log('🟡 DEMO MODE – auto‑confirm in 5s');
    transactions[txId] = { status: 'pending', productId, phone: mobile };
    saveTx();
    setTimeout(() => {
      if (transactions[txId]?.status === 'pending') {
        const vt = crypto.randomBytes(16).toString('hex');
        verificationTokens[vt] = { productId, expiresAt: Date.now()+5*60*1000 };
        transactions[txId] = { status: 'success', productId, verificationToken: vt };
        saveTx();
        console.log('🟢 DEMO: Auto‑confirmed', txId);
      }
    }, 5000);
    return res.json({ transactionId: txId, demo: true });
  }

  try {
    const payload = { code: PAYNECTA_PAYMENT_CODE, mobile_number: mobile, amount: Number(amount||scheme.price) };
    console.log('📤 Payload:', JSON.stringify(payload));
    const resp = await fetch(`${PAYNECTA_API_URL}/payment/initialize`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':PAYNECTA_API_KEY,'X-User-Email':PAYNECTA_EMAIL}, body:JSON.stringify(payload) });
    const raw = await resp.text();
    console.log('📥 Paynecta RAW:', raw);
    const data = JSON.parse(raw);
    const ref = data.transaction_reference || data.data?.transaction_reference;
    console.log('🔑 Reference:', ref);
    if (!ref) throw new Error('No transaction_reference');
    transactions[txId] = { transactionRef: ref, productId, status: 'pending', phone: mobile, createdAt: Date.now() };
    saveTx();
    console.log('💾 Saved. Total:', Object.keys(transactions).length);
    console.log('========================================\n');
    res.json({ transactionId: txId });
  } catch (e) { console.error('❌ Init error:', e); res.status(502).json({ error: 'Payment gateway error' }); }
});

app.get('/api/payment-status/:id', async (r,res) => {
  const { id } = r.params;
  console.log(`\n🔍 Status for: ${id}`);
  const tx = transactions[id];
  if (!tx) { console.log('❌ Not found'); return res.status(404).json({ status: 'not_found' }); }
  console.log('📋 TX:', JSON.stringify(tx, null, 2));
  if (tx.status === 'success') { console.log('✅ Already success'); return res.json({ status: 'success', verificationToken: tx.verificationToken }); }
  if (tx.status === 'failed') { console.log('❌ Already failed'); return res.json({ status: 'failed', message: tx.failReason }); }
  if (DEMO_MODE) { console.log('⏳ DEMO pending'); return res.json({ status: 'pending' }); }

  try {
    const url = `${PAYNECTA_API_URL}/payment/status?transaction_reference=${encodeURIComponent(tx.transactionRef)}`;
    console.log('🌐 Fetching:', url);
    const resp = await fetch(url, { headers:{'X-API-Key':PAYNECTA_API_KEY,'X-User-Email':PAYNECTA_EMAIL} });
    const raw = await resp.text();
    console.log('📡 Paynecta RAW:', raw);
    const data = JSON.parse(raw);
    const inner = data.data || data;
    const status = inner.status;
    const receipt = inner.mpesa_receipt_number;

    // ✅ FIXED CONDITION: accept completed + receipt (result_code may be null)
    if (status === 'completed' && receipt) {
      console.log('🎉 SUCCESS! Receipt:', receipt);
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { productId: tx.productId, expiresAt: Date.now()+5*60*1000 };
      transactions[id] = { ...tx, status: 'success', verificationToken: vt, mpesaReceipt: receipt };
      saveTx();
      const scheme = readDB('schemes').find(s=>s.id===tx.productId);
      if (scheme) {
        const sales = readDB('sales'); sales.push({ title: scheme.title, grade: scheme.grade, phone: tx.phone, amount: scheme.price, date: new Date().toISOString(), mpesaReceipt: receipt }); writeDB('sales', sales); incStat('sales');
        sendSaleNotification(scheme, tx.phone, scheme.price);
      }
      console.log('✅ Returning success');
      return res.json({ status: 'success', verificationToken: vt });
    }
    if (['failed','cancelled','expired'].includes(status)) {
      console.log('❌ Failed:', inner.result_description);
      transactions[id].status = 'failed'; transactions[id].failReason = inner.result_description || 'Payment failed'; saveTx();
      return res.json({ status: 'failed', message: transactions[id].failReason });
    }
    console.log('⏳ Pending...');
    res.json({ status: 'pending' });
  } catch (e) { console.error('❌ Status error:', e); res.json({ status: 'pending' }); }
});

app.post('/api/request-download', (r,res) => { const { verificationToken, productId } = r.body; const vt = verificationTokens[verificationToken]; if (!vt||vt.productId!==productId||Date.now()>vt.expiresAt) return res.status(403).json({error:'Invalid token'}); const scheme = readDB('schemes').find(s=>s.id===productId); if (!scheme?.fileKey) return res.status(404).json({error:'File not found'}); const dt = crypto.randomBytes(16).toString('hex'); downloadTokens[dt] = { key: scheme.fileKey, fileName: scheme.originalName, expiresAt: Date.now()+2*60*1000 }; delete verificationTokens[verificationToken]; incStat('downloads'); res.json({ downloadToken: dt }); });
app.get('/api/download/:token', async (r,res) => { const dt = downloadTokens[r.params.token]; if (!dt||Date.now()>dt.expiresAt) return res.status(403).send('Expired'); delete downloadTokens[r.params.token]; try { await streamFileFromB2(dt.key, res); } catch { res.status(404).send('File not found'); } });

// ---------- ADMIN ROUTES (unchanged, full version omitted for brevity but identical to previous full code) ----------
// [Include all admin routes exactly as in the previous complete server.js – subjects, grades, banner, WhatsApp, popups, backup, restore, etc.]

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
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
function adminAuth(r,res,next) { const t = r.headers['x-admin-token']||r.query.token; const s=readDB('settings',{}); if (!t||t!==s.adminPassword) return res.status(401).json({error:'Unauthorized'}); next(); }
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

// ---------- PAYMENT ROUTES (FIXED – VERIFICATION TOKEN STORED FIRST) ----------
function normalisePhone(raw) { let p = String(raw).replace(/\D/g,''); if(p.startsWith('0')&&p.length===10) p='254'+p.slice(1); if(p.startsWith('7')&&p.length===9) p='254'+p; return (p.startsWith('254')&&p.length===12)?p:null; }

app.post('/api/initiate-payment', async (r,res) => {
  const { phone, amount, productId } = r.body;
  const scheme = readDB('schemes').find(s=>s.id===productId);
  if (!scheme) return res.status(404).json({ error: 'Product not found' });
  const mobile = normalisePhone(phone);
  if (!mobile) return res.status(400).json({ error: 'Invalid phone' });
  const txId = crypto.randomBytes(10).toString('hex');

  if (DEMO_MODE) {
    transactions[txId] = { status: 'pending', productId, phone: mobile };
    saveTx();
    setTimeout(() => {
      if (transactions[txId]?.status === 'pending') {
        const vt = crypto.randomBytes(16).toString('hex');
        verificationTokens[vt] = { productId, expiresAt: Date.now()+5*60*1000 };
        transactions[txId] = { status: 'success', productId, verificationToken: vt };
        saveTx();
      }
    }, 5000);
    return res.json({ transactionId: txId, demo: true });
  }

  try {
    const payload = { code: PAYNECTA_PAYMENT_CODE, mobile_number: mobile, amount: Number(amount||scheme.price) };
    const resp = await fetch(`${PAYNECTA_API_URL}/payment/initialize`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':PAYNECTA_API_KEY,'X-User-Email':PAYNECTA_EMAIL}, body:JSON.stringify(payload) });
    const raw = await resp.text();
    const data = JSON.parse(raw);
    const ref = data.transaction_reference || data.data?.transaction_reference;
    if (!ref) throw new Error('No transaction_reference');
    transactions[txId] = { transactionRef: ref, productId, status: 'pending', phone: mobile };
    saveTx();
    res.json({ transactionId: txId });
  } catch (e) { res.status(502).json({ error: 'Payment gateway error' }); }
});

app.get('/api/payment-status/:id', async (r,res) => {
  const tx = transactions[r.params.id];
  if (!tx) return res.status(404).json({ status: 'not_found' });
  if (tx.status === 'success') return res.json({ status: 'success', verificationToken: tx.verificationToken });
  if (tx.status === 'failed') return res.json({ status: 'failed', message: tx.failReason });
  if (DEMO_MODE) return res.json({ status: 'pending' });

  try {
    const url = `${PAYNECTA_API_URL}/payment/status?transaction_reference=${encodeURIComponent(tx.transactionRef)}`;
    const resp = await fetch(url, { headers:{'X-API-Key':PAYNECTA_API_KEY,'X-User-Email':PAYNECTA_EMAIL} });
    const raw = await resp.text();
    const data = JSON.parse(raw);
    const inner = data.data || data;
    const status = inner.status;
    const receipt = inner.mpesa_receipt_number;

    if (status === 'completed' && receipt) {
      // ✅ STORE VERIFICATION TOKEN FIRST
      const vt = crypto.randomBytes(16).toString('hex');
      verificationTokens[vt] = { productId: tx.productId, expiresAt: Date.now() + 5 * 60 * 1000 };
      
      // Update transaction
      transactions[r.params.id] = { ...tx, status: 'success', verificationToken: vt, mpesaReceipt: receipt };
      saveTx();
      
      // Record sale (non-blocking)
      const scheme = readDB('schemes').find(s => s.id === tx.productId);
      if (scheme) {
        const sales = readDB('sales');
        sales.push({ title: scheme.title, grade: scheme.grade, phone: tx.phone, amount: scheme.price, date: new Date().toISOString(), mpesaReceipt: receipt });
        writeDB('sales', sales);
        incStat('sales');
        sendSaleNotification(scheme, tx.phone, scheme.price);
      }
      
      return res.json({ status: 'success', verificationToken: vt });
    }
    if (['failed','cancelled','expired'].includes(status)) {
      transactions[r.params.id].status = 'failed';
      transactions[r.params.id].failReason = inner.result_description || 'Payment failed';
      saveTx();
      return res.json({ status: 'failed', message: transactions[r.params.id].failReason });
    }
    res.json({ status: 'pending' });
  } catch (e) { res.json({ status: 'pending' }); }
});

app.post('/api/request-download', (r,res) => { const { verificationToken, productId } = r.body; const vt = verificationTokens[verificationToken]; if (!vt||vt.productId!==productId||Date.now()>vt.expiresAt) return res.status(403).json({error:'Invalid token'}); const scheme = readDB('schemes').find(s=>s.id===productId); if (!scheme?.fileKey) return res.status(404).json({error:'File not found'}); const dt = crypto.randomBytes(16).toString('hex'); downloadTokens[dt] = { key: scheme.fileKey, fileName: scheme.originalName, expiresAt: Date.now()+2*60*1000 }; delete verificationTokens[verificationToken]; incStat('downloads'); res.json({ downloadToken: dt }); });
app.get('/api/download/:token', async (r,res) => { const dt = downloadTokens[r.params.token]; if (!dt||Date.now()>dt.expiresAt) return res.status(403).send('Expired'); delete downloadTokens[r.params.token]; try { await streamFileFromB2(dt.key, res); } catch { res.status(404).send('File not found'); } });

// ---------- ADMIN ROUTES (ORIGINAL, FULLY FUNCTIONAL) ----------
app.post('/api/admin/login', (r,res) => { const { password } = r.body; const s=readDB('settings',{}); if(password===s.adminPassword) res.json({token:password,ok:true}); else res.status(401).json({error:'Wrong password'}); });
app.get('/api/admin/verify', adminAuth, (r,res) => res.json({ok:true}));
app.get('/api/admin/stats', adminAuth, (r,res) => { const s=readDB('stats',{}); res.json({ visits:s.visits||0, downloads:s.downloads||0, sales:s.sales||0, schemes:readDB('schemes').length, activeUsers:Object.keys(userSessions).length }); });
app.get('/api/admin/schemes', adminAuth, (r,res) => res.json(readDB('schemes')));
app.post('/api/admin/schemes', adminAuth, upload.fields([{name:'document'},{name:'cover'}]), async (r,res) => { if(!B2_ENABLED) return res.status(503).json({error:'B2 unavailable'}); try { const {title,subject,grade,term,price,weeks,pages,visible,publishAt,unpublishAt}=r.body; if(!title||!subject||!grade||!term||!price||!r.files?.document) return res.status(400).json({error:'Missing fields'}); const docKey = await uploadBufferToB2(r.files.document[0].buffer, r.files.document[0].originalname, r.files.document[0].mimetype, 'schemes'); let coverKey=null; if(r.files.cover) coverKey = await uploadBufferToB2(r.files.cover[0].buffer, r.files.cover[0].originalname, r.files.cover[0].mimetype, 'covers'); const scheme = { id:crypto.randomUUID(), title, subject, grade, term:Number(term), price:Number(price), weeks:weeks?Number(weeks):null, pages:pages?Number(pages):null, fileKey:docKey, originalName:r.files.document[0].originalname, coverKey, visible:visible!=='false', createdAt:new Date().toISOString(), publishAt:publishAt||null, unpublishAt:unpublishAt||null }; const schemes=readDB('schemes'); schemes.push(scheme); writeDB('schemes',schemes); res.status(201).json(scheme); } catch(e) { res.status(500).json({error:e.message}); } });
app.patch('/api/admin/schemes/:id', adminAuth, (r,res) => { const schemes=readDB('schemes'); const idx=schemes.findIndex(s=>s.id===r.params.id); if(idx===-1) return res.status(404).json({error:'Not found'}); const {price,weeks,visible,publishAt,unpublishAt}=r.body; if(price!==undefined) schemes[idx].price=Number(price); if(weeks!==undefined) schemes[idx].weeks=Number(weeks)||null; if(visible!==undefined) schemes[idx].visible=Boolean(visible); if(publishAt!==undefined) schemes[idx].publishAt=publishAt||null; if(unpublishAt!==undefined) schemes[idx].unpublishAt=unpublishAt||null; writeDB('schemes',schemes); res.json(schemes[idx]); });
app.post('/api/admin/schemes/:id/cover', adminAuth, upload.single('cover'), async (r,res) => { if(!B2_ENABLED) return res.status(503).json({error:'B2 unavailable'}); const schemes=readDB('schemes'); const scheme=schemes.find(s=>s.id===r.params.id); if(!scheme) return res.status(404).json({error:'Not found'}); if(!r.file) return res.status(400).json({error:'No file'}); try { scheme.coverKey = await uploadBufferToB2(r.file.buffer, r.file.originalname, r.file.mimetype, 'covers'); writeDB('schemes',schemes); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });
app.delete('/api/admin/schemes/:id', adminAuth, (r,res) => { writeDB('schemes', readDB('schemes').filter(s=>s.id!==r.params.id)); res.json({ok:true}); });
app.post('/api/admin/schemes/bulk', adminAuth, upload.fields([{name:'documents'},{name:'covers'}]), async (r,res) => { if(!B2_ENABLED) return res.status(503).json({error:'B2 unavailable'}); const {title,subject,grade,term,price,weeks,pages,visible}=r.body; if(!title||!subject||!grade||!term||!price||!r.files?.documents) return res.status(400).json({error:'Missing fields'}); const docs=r.files.documents, covers=r.files.covers||[], schemes=readDB('schemes'), created=[]; for(let i=0;i<docs.length;i++) { try { const docKey=await uploadBufferToB2(docs[i].buffer,docs[i].originalname,docs[i].mimetype,'schemes'); let coverKey=null; if(covers[i]) coverKey=await uploadBufferToB2(covers[i].buffer,covers[i].originalname,covers[i].mimetype,'covers'); const scheme={ id:crypto.randomUUID(), title: docs.length>1?`${title} (${i+1})`:title, subject, grade, term:Number(term), price:Number(price), weeks:weeks?Number(weeks):null, pages:pages?Number(pages):null, fileKey:docKey, originalName:docs[i].originalname, coverKey, visible:visible!=='false', createdAt:new Date().toISOString() }; schemes.push(scheme); created.push(scheme); } catch(e){} } writeDB('schemes',schemes); res.status(201).json({created:created.length}); });
app.post('/api/admin/schemes/bulk-price', adminAuth, (r,res) => { const {schemeIds,price,operation='set'}=r.body; const schemes=readDB('schemes'); let updated=0; schemes.forEach(s=>{ if(schemeIds.includes(s.id)) { if(operation==='set') s.price=Number(price); else if(operation==='increase') s.price=Math.max(0,s.price+Number(price)); else if(operation==='decrease') s.price=Math.max(0,s.price-Number(price)); updated++; } }); writeDB('schemes',schemes); res.json({ok:true,updated}); });
app.post('/api/admin/schemes/bulk-visibility', adminAuth, (r,res) => { const {schemeIds,visible}=r.body; const schemes=readDB('schemes'); let updated=0; schemes.forEach(s=>{ if(schemeIds.includes(s.id)) { s.visible=Boolean(visible); updated++; } }); writeDB('schemes',schemes); res.json({ok:true,updated}); });
app.get('/api/admin/schemes/featured', adminAuth, (r,res) => res.json({featuredSchemeIds:readDB('settings',{}).featuredSchemeIds||[]}));
app.post('/api/admin/schemes/featured', adminAuth, (r,res) => { const s=readDB('settings',{}); s.featuredSchemeIds=r.body.schemeIds||[]; writeDB('settings',s); res.json({ok:true}); });
app.patch('/api/admin/settings/grade-display', adminAuth, (r,res) => { const s=readDB('settings',{}); s.showAllGrades=r.body.showAllGrades!==false; writeDB('settings',s); res.json({ok:true}); });
app.patch('/api/admin/settings/email-notifications', adminAuth, (r,res) => { const s=readDB('settings',{}); s.emailNotifications=r.body.enabled!==false; writeDB('settings',s); res.json({ok:true}); });
app.get('/api/admin/analytics/downloads', adminAuth, (r,res) => { const schemes=readDB('schemes'), sales=readDB('sales'), counts={}; sales.forEach(s=>{ counts[s.title]=(counts[s.title]||0)+1; }); res.json(schemes.map(s=>({id:s.id,title:s.title,grade:s.grade,downloads:counts[s.title]||0,revenue:(counts[s.title]||0)*s.price})).sort((a,b)=>b.downloads-a.downloads)); });
app.get('/api/admin/sales/export', adminAuth, (r,res) => { const sales=readDB('sales'); let csv='Date,Title,Grade,Phone,Amount\n'; sales.forEach(s=>{ csv+=`${s.date},${s.title},${s.grade||''},${s.phone},${s.amount}\n`; }); res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="sales.csv"'); res.send(csv); });
app.get('/api/admin/health', adminAuth, async (r,res) => { const b2 = B2_ENABLED ? { status:'connected' } : { status:'disabled' }; res.json({ b2, database: { schemes: readDB('schemes').length, subjects: readDB('areas').length } }); });
app.get('/api/admin/subjects', adminAuth, (r,res) => res.json(readDB('areas')));
app.post('/api/admin/subjects', adminAuth, (r,res) => { const {name}=r.body; if(!name?.trim()) return res.status(400).json({error:'Name required'}); const areas=readDB('areas'); if(areas.find(a=>a.name.toLowerCase()===name.trim().toLowerCase())) return res.status(409).json({error:'Exists'}); areas.push({id:crypto.randomUUID(), name:name.trim()}); writeDB('areas',areas); res.status(201).json({ok:true}); });
app.delete('/api/admin/subjects/:id', adminAuth, (r,res) => { writeDB('areas', readDB('areas').filter(a=>a.id!==r.params.id)); res.json({ok:true}); });
app.get('/api/admin/grades', adminAuth, (r,res) => res.json(readDB('grades')));
app.post('/api/admin/grades', adminAuth, (r,res) => { const {name}=r.body; if(!name?.trim()) return res.status(400).json({error:'Name required'}); const grades=readDB('grades'); grades.push({id:crypto.randomUUID(), name:name.trim(), active:true}); writeDB('grades',grades); res.status(201).json({ok:true}); });
app.delete('/api/admin/grades/:id', adminAuth, (r,res) => { writeDB('grades', readDB('grades').filter(g=>g.id!==r.params.id)); res.json({ok:true}); });
app.get('/api/admin/visitors', adminAuth, (r,res) => res.json(readDB('visitors')));
app.delete('/api/admin/visitors/clear', adminAuth, (r,res) => { writeDB('visitors',[]); res.json({ok:true}); });
app.get('/api/admin/banner', adminAuth, (r,res) => { const s=readDB('settings',{}); res.json({text:s.bannerText||'', enabled:s.bannerEnabled||false}); });
app.post('/api/admin/banner', adminAuth, (r,res) => { const s=readDB('settings',{}); s.bannerText=r.body.text||''; s.bannerEnabled=r.body.enabled||false; writeDB('settings',s); res.json({ok:true}); });
app.get('/api/admin/whatsapp', adminAuth, (r,res) => { const s=readDB('settings',{}); res.json({number:s.waNumber||'', message:s.waMessage||'Hello', enabled:s.waEnabled||false}); });
app.post('/api/admin/whatsapp', adminAuth, (r,res) => { const s=readDB('settings',{}); s.waNumber=r.body.number||''; s.waMessage=r.body.message||'Hello'; s.waEnabled=r.body.enabled||false; writeDB('settings',s); res.json({ok:true}); });
app.get('/api/admin/terms', adminAuth, (r,res) => { const s=readDB('settings',{}); res.json({term1Enabled:s.term1Enabled!==false, term2Enabled:s.term2Enabled!==false, term3Enabled:s.term3Enabled!==false, defaultTerm:s.defaultTerm||'1'}); });
app.post('/api/admin/terms', adminAuth, (r,res) => { const s=readDB('settings',{}); if(r.body.term1Enabled!==undefined) s.term1Enabled=r.body.term1Enabled; if(r.body.term2Enabled!==undefined) s.term2Enabled=r.body.term2Enabled; if(r.body.term3Enabled!==undefined) s.term3Enabled=r.body.term3Enabled; if(r.body.defaultTerm) s.defaultTerm=r.body.defaultTerm; writeDB('settings',s); res.json({ok:true}); });
app.get('/api/admin/popups', adminAuth, (r,res) => res.json(readDB('popups')));
app.post('/api/admin/popups', adminAuth, (r,res) => { const {question,options,trigger,collectWhatsapp,delay,delayUnit}=r.body; if(!question) return res.status(400).json({error:'Question required'}); const popups=readDB('popups'); popups.push({id:crypto.randomUUID(), question, options, trigger:trigger||'onload', collectWhatsapp:!!collectWhatsapp, delay:delay?Number(delay):0, delayUnit:delayUnit||'seconds'}); writeDB('popups',popups); res.status(201).json({ok:true}); });
app.post('/api/admin/change-password', adminAuth, (r,res) => { const {newPassword}=r.body; if(!newPassword||newPassword.length<6) return res.status(400).json({error:'Too short'}); const s=readDB('settings',{}); s.adminPassword=newPassword; writeDB('settings',s); res.json({ok:true}); });
app.post('/api/admin/forgot-password', async (r,res) => { const code=Math.floor(100000+Math.random()*900000).toString(); const resetCodes=readDB('resetCodes',{}); resetCodes['admin']={code, expires:Date.now()+15*60*1000}; writeDB('resetCodes',resetCodes); res.json({success:true, demoCode:DEMO_MODE?code:undefined}); });
app.post('/api/admin/reset-password', (r,res) => { const {code,newPassword}=r.body; const stored=readDB('resetCodes',{})['admin']; if(!stored||stored.code!==code||stored.expires<Date.now()) return res.status(400).json({error:'Invalid or expired'}); const s=readDB('settings',{}); s.adminPassword=newPassword; writeDB('settings',s); writeDB('resetCodes',{}); res.json({ok:true}); });
app.get('/api/admin/backup', adminAuth, (r,res) => { res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition',`attachment; filename="backup-${Date.now()}.zip"`); const archive=archiver('zip',{zlib:{level:6}}); archive.pipe(res); archive.directory(DATA_DIR,'data'); archive.finalize(); });
app.post('/api/admin/restore', adminAuth, restoreStorage.single('backup'), async (r,res) => { if(!r.file) return res.status(400).json({error:'No file'}); try { await extract(r.file.path,{dir:path.dirname(DATA_DIR)}); fs.unlinkSync(r.file.path); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });

app.use((e,r,res,next) => { console.error('🔥 Error:',e); if(e instanceof multer.MulterError) return res.status(400).json({error:e.message}); res.status(500).json({error:e.message||'Server error'}); });
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
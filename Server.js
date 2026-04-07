require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------
// Local Storage for Uploads
// ------------------------------
const UPLOAD_DIR = 'uploads';
const COVERS_DIR = 'covers';
[UPLOAD_DIR, COVERS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'coverImage' ? COVERS_DIR : UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`)
});
const upload = multer({ storage });

// ------------------------------
// Data Files (JSON)
// ------------------------------
const FILES = { PRODUCTS: 'products.json', STATS: 'stats.json', MESSAGES: 'messages.json', ACTIVITY: 'activity.json', CLIENTS: 'clients.json', FEEDBACK: 'feedback.json', TERM_SETTINGS: 'term_settings.json', BANNER: 'banner.json', WHATSAPP: 'whatsapp.json', POPUPS: 'popups.json', LEARNING_AREAS: 'learning_areas.json', GRADES: 'grades.json' };

const readJSON = (file, def = []) => {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : (fs.writeFileSync(file, JSON.stringify(def, null, 2)), def); }
    catch { return def; }
};
const writeJSON = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); return true; } catch { return false; } };

const getClientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ------------------------------
// Memory State (INSTANT ACCESS)
// ------------------------------
const activePayments = new Map(); // txId -> { status, productId, amount, phone }const verifiedPayments = new Map(); // token -> { productId, transactionId, amount, expires }
const downloadTokens = new Map();   // token -> { productId, expires }
const activeSessions = new Map();
let cacheVersion = Date.now();

setInterval(() => {
    const now = Date.now();
    for (const [id, d] of activeSessions.entries()) if (now - d.lastSeen > 60000) activeSessions.delete(id);
    for (const [id, d] of activePayments.entries()) if (d.status !== 'pending' && now - d.created > 300000) activePayments.delete(id); // Clean old
}, 30000);

const defaultLearningAreas = [{ id: 1, name: "Mathematics", active: true }, { id: 2, name: "English", active: true }, { id: 3, name: "Kiswahili", active: true }, { id: 4, name: "Creative Arts", active: true }, { id: 5, name: "Social Studies", active: true }, { id: 6, name: "Integrated Science", active: true }, { id: 7, name: "Pre-technical Studies", active: true }, { id: 8, name: "Agriculture", active: true }];
const defaultGrades = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `Grade ${i + 1}`, active: true }));

// ------------------------------
// Admin Auth
// ------------------------------
const ADMIN_PASSWORD = '0726019859';
const RECOVERY_EMAIL = 'victorngetich388@gmail.com';
let resetCodes = {};
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER || RECOVERY_EMAIL, pass: process.env.EMAIL_PASS } });

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true, token: Buffer.from(Date.now().toString()).toString('base64') });
    else res.status(401).json({ success: false, error: 'Wrong password' });
});
const isAdmin = (req, res, next) => req.headers['x-admin-token'] ? next() : res.status(401).json({ error: 'Unauthorized' });

app.post('/api/admin/forgot-password', async (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes[code] = Date.now() + 3600000;
    try { await transporter.sendMail({ from: `"SchemeVault" <${RECOVERY_EMAIL}>`, to: RECOVERY_EMAIL, subject: 'Reset Code', text: `Code: ${code}` }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/cache-version', (req, res) => res.json({ version: cacheVersion }));
app.post('/api/admin/clear-cache', isAdmin, (req, res) => { cacheVersion = Date.now(); res.json({ success: true, version: cacheVersion }); });

// 👥 Active Users
app.post('/api/heartbeat', (req, res) => {
    if (!req.body.sessionId) return res.status(400).json({ error: 'sessionId required' });
    activeSessions.set(req.body.sessionId, { ip: getClientIp(req), ua: req.headers['user-agent'], lastSeen: Date.now(), firstSeen: activeSessions.get(req.body.sessionId)?.firstSeen || Date.now() });
    res.json({ success: true, activeCount: activeSessions.size });
});
app.get('/api/admin/active-users', isAdmin, (req, res) => {
    const now = Date.now(); const list = [];
    for (const [id, d] of activeSessions.entries()) if (now - d.lastSeen <= 60000) list.push({ id: id.slice(0, 8), ip: d.ip, lastSeen: d.lastSeen, dur: Math.floor((now - d.firstSeen) / 1000) });
    res.json({ activeCount: list.length, activeUsers: list });
});
app.post('/api/leave', (req, res) => { if (req.body.sessionId) activeSessions.delete(req.body.sessionId); res.json({ success: true }); });

// 📚 CRUD Generatorsconst setupCRUD = (file, defs, ep) => {
    app.get(`/api/${ep}`, (req, res) => { let i = readJSON(file, []); if (!i.length) { i = defs; writeJSON(file, i); } res.json(i.filter(x => x.active !== false)); });
    app.get(`/api/admin/${ep}`, isAdmin, (req, res) => { let i = readJSON(file, []); if (!i.length) { i = defs; writeJSON(file, i); } res.json(i); });
    app.post(`/api/admin/${ep}`, isAdmin, (req, res) => {
        if (!req.body.name) return res.status(400).json({ error: 'Name required' });
        let items = readJSON(file, []); items.push({ id: items.length ? Math.max(...items.map(x => x.id)) + 1 : 1, name: req.body.name, active: req.body.active !== false }); writeJSON(file, items); cacheVersion = Date.now(); res.json({ success: true, item: items[items.length - 1] });
    });
    app.put(`/api/admin/${ep}/:id`, isAdmin, (req, res) => {
        const id = parseInt(req.params.id); let items = readJSON(file, []); const idx = items.findIndex(x => x.id === id); if (idx === -1) return res.status(404).json({ error: 'Not found' });
        if (req.body.name !== undefined) items[idx].name = req.body.name; if (req.body.active !== undefined) items[idx].active = req.body.active; writeJSON(file, items); cacheVersion = Date.now(); res.json({ success: true, item: items[idx] });
    });
    app.delete(`/api/admin/${ep}/:id`, isAdmin, (req, res) => { let items = readJSON(file, []).filter(x => x.id !== parseInt(req.params.id)); writeJSON(file, items); cacheVersion = Date.now(); res.json({ success: true }); });
};
setupCRUD(FILES.LEARNING_AREAS, defaultLearningAreas, 'learning-areas');
setupCRUD(FILES.GRADES, defaultGrades, 'grades');

// 📅 Term Settings
app.get('/api/term-settings', (req, res) => res.json(readJSON(FILES.TERM_SETTINGS, { term1: true, term2: true, term3: true })));
app.get('/api/admin/term-settings', isAdmin, (req, res) => res.json(readJSON(FILES.TERM_SETTINGS, { term1: true, term2: true, term3: true })));
app.put('/api/admin/term-settings', isAdmin, (req, res) => { writeJSON(FILES.TERM_SETTINGS, req.body); cacheVersion = Date.now(); res.json({ success: true }); });

// 📦 Products
app.get('/api/products', (req, res) => res.json(readJSON(FILES.PRODUCTS, []).filter(p => p.visible !== false)));
app.get('/api/admin/products', isAdmin, (req, res) => res.json(readJSON(FILES.PRODUCTS, [])));
app.post('/api/admin/products', isAdmin, upload.fields([{ name: 'pdfFile' }, { name: 'coverImage' }]), (req, res) => {
    try {
        const { title, grade, term, subject, price, pages, visible } = req.body;
        if (!title || !grade || !term || !subject || !price) return res.status(400).json({ error: 'Missing fields' });
        const pdf = req.files?.pdfFile?.[0]; if (!pdf) return res.status(400).json({ error: 'PDF required' });
        const cover = req.files?.coverImage?.[0];
        const products = readJSON(FILES.PRODUCTS, []);
        const newP = { id: products.length ? Math.max(...products.map(p => p.id)) + 1 : 1, title: title.trim(), grade: grade.trim(), term: parseInt(term), subject: subject.trim(), price: parseInt(price), pages: pages ? parseInt(pages) : null, fileUrl: `/uploads/${pdf.filename}`, coverUrl: cover ? `/covers/${cover.filename}` : null, visible: visible === 'true' || visible === true, createdAt: new Date().toISOString() };
        products.push(newP); writeJSON(FILES.PRODUCTS, products); cacheVersion = Date.now(); res.json({ success: true, product: newP });
    } catch (e) { res.status(500).json({ error: 'Upload failed: ' + e.message }); }
});
app.put('/api/admin/products/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id); let p = readJSON(FILES.PRODUCTS, []); const idx = p.findIndex(x => x.id === id); if (idx === -1) return res.status(404).json({ error: 'Not found' });
    ['title','grade','term','subject','price','pages','visible'].forEach(k => { if (req.body[k] !== undefined) p[idx][k] = ['price','pages','term'].includes(k) ? parseInt(req.body[k]) : (k === 'visible' ? (req.body[k] === 'true' || req.body[k] === true) : req.body[k]); });
    writeJSON(FILES.PRODUCTS, p); cacheVersion = Date.now(); res.json({ success: true, product: p[idx] });
});
app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id); let p = readJSON(FILES.PRODUCTS, []); const prod = p.find(x => x.id === id);
    if (prod?.fileUrl) { const f = path.join(UPLOAD_DIR, prod.fileUrl.split('/').pop()); if (fs.existsSync(f)) fs.unlinkSync(f); }
    if (prod?.coverUrl) { const f = path.join(COVERS_DIR, prod.coverUrl.split('/').pop()); if (fs.existsSync(f)) fs.unlinkSync(f); }
    p = p.filter(x => x.id !== id); writeJSON(FILES.PRODUCTS, p); cacheVersion = Date.now(); res.json({ success: true });
});

// ------------------------------
// 💳 PAYMENT & DOWNLOAD (MEMORY-BASED, NO TIMEOUTS)
// ------------------------------app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, productId } = req.body;
    if (!phone || !amount || !productId) return res.status(400).json({ success: false, error: 'Missing fields' });
    let cleanPhone = phone.replace(/\s/g, ''); if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1); else if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.slice(1);
    const txId = `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // ✅ INSTANT MEMORY REGISTRATION
    activePayments.set(txId, { status: 'pending', productId: parseInt(productId), amount: parseInt(amount), phone: cleanPhone, created: Date.now() });

    const cfg = process.env.PAYNECTA_API_KEY && process.env.PAYNECTA_EMAIL && process.env.PAYNECTA_PAYMENT_CODE;
    if (!cfg) {
        console.log(`🧪 Demo Mode: Auto-confirming ${txId} in 1s`);
        setTimeout(() => {
            const p = activePayments.get(txId);
            if (p && p.status === 'pending') {
                p.status = 'success';
                const vtok = `DEMO_${Date.now()}`;
                verifiedPayments.set(vtok, { productId: p.productId, transactionId: txId, amount: p.amount, expires: Date.now() + 300000 });
                console.log(`✅ Demo Success: ${txId}`);
                // Save to disk for persistence
                const stats = readJSON(FILES.STATS, { payments: [] });
                if (!stats.payments) stats.payments = [];
                stats.payments.push({ transactionId: txId, date: new Date().toISOString(), status: 'success', amount: p.amount, phone: p.phone, productId: p.productId, ip: getClientIp(req) });
                writeJSON(FILES.STATS, stats);
            }
        }, 1000);
        return res.json({ success: true, transactionId: txId, demo: true });
    }

    try {
        const r = await axios.post(`${process.env.PAYNECTA_API_URL}/api/v1/payment/initialize`, { code: process.env.PAYNECTA_PAYMENT_CODE, mobile_number: cleanPhone, amount: parseInt(amount) }, { headers: { 'X-API-Key': process.env.PAYNECTA_API_KEY, 'X-User-Email': process.env.PAYNECTA_EMAIL }, timeout: 30000 });
        if (r.data?.success) { res.json({ success: true, transactionId: txId }); console.log(`🌐 STK Sent: ${txId}`); }
        else { activePayments.get(txId).status = 'failed'; res.status(400).json({ success: false, error: r.data?.message || 'Failed' }); }
    } catch (e) { activePayments.get(txId).status = 'failed'; res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/payment-status/:transactionId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const { transactionId } = req.params;
    
    // ✅ CHECK MEMORY FIRST (INSTANT)
    let pay = activePayments.get(transactionId);
    
    // Fallback to disk if not in memory
    if (!pay) {
        const stats = readJSON(FILES.STATS, { payments: [] });
        pay = stats.payments?.find(x => x.transactionId === transactionId);
    }

    if (!pay) return res.json({ status: 'not_found', verified: false });    
    if (pay.status === 'success') {
        let verifyToken = null;
        for (const [t, d] of verifiedPayments.entries()) if (d.transactionId === pay.transactionId && d.expires > Date.now()) { verifyToken = t; break; }
        if (!verifyToken) {
            verifyToken = `VER_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
            verifiedPayments.set(verifyToken, { productId: pay.productId, transactionId: pay.transactionId, amount: pay.amount, expires: Date.now() + 300000 });
        }
        return res.json({ status: 'success', verified: true, token: verifyToken });
    }
    res.json({ status: pay.status, verified: false });
});

app.post('/api/payment-webhook', (req, res) => {
    console.log('📡 Webhook:', req.body);
    if (req.body.ResultCode === 0 && req.body.reference) {
        const p = activePayments.get(req.body.reference);
        if (p) p.status = 'success';
        verifiedPayments.set(`WEB_${Date.now()}`, { productId: p?.productId || 0, transactionId: req.body.reference, amount: p?.amount || 0, expires: Date.now() + 300000 });
    }
    res.sendStatus(200);
});

app.post('/api/request-download', (req, res) => {
    const { verificationToken, productId } = req.body;
    if (!verificationToken || productId === undefined) return res.status(400).json({ error: 'Missing data' });
    const v = verifiedPayments.get(verificationToken);
    if (!v || v.expires < Date.now()) return res.status(403).json({ error: 'Expired' });
    if (Number(v.productId) !== Number(productId)) return res.status(403).json({ error: 'Mismatch' });
    const dtoken = `DL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    downloadTokens.set(dtoken, { productId: Number(productId), expires: Date.now() + 60000 });
    verifiedPayments.delete(verificationToken);
    res.json({ success: true, token: dtoken });
});

app.get('/api/download/:token', (req, res) => {
    const rec = downloadTokens.get(req.params.token); if (!rec || rec.expires < Date.now()) return res.status(403).send('Expired');
    const p = readJSON(FILES.PRODUCTS, []).find(x => x.id === rec.productId); if (!p?.fileUrl) return res.status(404).send('File missing');
    const fp = path.join(__dirname, p.fileUrl); if (!fs.existsSync(fp)) return res.status(404).send('Missing on server');
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(p.title)}.pdf"`);
    fs.createReadStream(fp).pipe(res); downloadTokens.delete(req.params.token);
    const s = readJSON(FILES.STATS, { downloads: [] }); s.downloads.push({ date: new Date().toISOString(), productId: p.id, productName: p.title, price: p.price, ip: getClientIp(req) }); writeJSON(FILES.STATS, s);
});

app.post('/api/admin/force-confirm', isAdmin, (req, res) => {
    const s = readJSON(FILES.STATS, { payments: [] }); const p = s.payments?.find(x => x.transactionId === req.body.transactionId);
    if (!p) return res.status(404).json({ error: 'Not found' }); p.status = 'success'; writeJSON(FILES.STATS, s); const t = `ADM_${Date.now()}`; verifiedPayments.set(t, { productId: parseInt(req.body.productId), transactionId: p.transactionId, amount: p.amount, expires: Date.now() + 300000 }); res.json({ success: true, token: t });
});

// 🌐 Public & Admin Utilsapp.get('/api/messages', (req, res) => { const now = new Date(); res.json(readJSON(FILES.MESSAGES, []).filter(m => m.active && (!m.startDate || new Date(m.startDate) <= now) && (!m.endDate || new Date(m.endDate) >= now))); });
app.get('/api/popups', (req, res) => { const now = new Date(); res.json(readJSON(FILES.POPUPS, []).filter(p => p.active && (!p.startDate || new Date(p.startDate) <= now) && (!p.endDate || new Date(p.endDate) >= now))); });
app.post('/api/submit-feedback', (req, res) => { if (!req.body.message) return res.status(400).json({ error: 'Message required' }); const f = readJSON(FILES.FEEDBACK, []); f.push({ id: Date.now(), message: req.body.message.trim(), whatsapp: req.body.whatsapp?.trim() || '', ip: getClientIp(req), ts: new Date().toISOString(), read: false }); writeJSON(FILES.FEEDBACK, f); res.json({ success: true }); });
app.post('/api/track-visit', (req, res) => { const s = readJSON(FILES.STATS, { visits: [] }); s.visits.push({ date: new Date().toISOString(), ip: getClientIp(req) }); writeJSON(FILES.STATS, s); res.json({ success: true }); });
app.get('/api/admin/stats', isAdmin, (req, res) => { const s = readJSON(FILES.STATS, { visits: [], downloads: [], payments: [] }); const ok = s.payments?.filter(p => p.status === 'success') || []; res.json({ summary: { visits: s.visits.length, downloads: s.downloads.length, success: ok.length, revenue: ok.reduce((a,b)=>a+(b.amount||0),0) } }); });
app.get('/api/admin/feedback', isAdmin, (req, res) => res.json(readJSON(FILES.FEEDBACK, [])));
app.put('/api/admin/feedback/:id', isAdmin, (req, res) => { const f = readJSON(FILES.FEEDBACK, []); const i = f.findIndex(x => x.id === parseInt(req.params.id)); if (i > -1) { f[i].read = true; writeJSON(FILES.FEEDBACK, f); } res.json({ success: true }); });
app.get('/api/banner', (req, res) => res.json(readJSON(FILES.BANNER, { enabled: false, text: '', startDate: null, endDate: null })));
app.get('/api/admin/banner', isAdmin, (req, res) => res.json(readJSON(FILES.BANNER, { enabled: false, text: '', startDate: null, endDate: null })));
app.post('/api/admin/banner', isAdmin, (req, res) => { writeJSON(FILES.BANNER, req.body); cacheVersion = Date.now(); res.json({ success: true }); });
app.get('/api/admin/whatsapp', isAdmin, (req, res) => res.json(readJSON(FILES.WHATSAPP, { enabled: false, phone: '', message: '' })));
app.post('/api/admin/whatsapp', isAdmin, (req, res) => { writeJSON(FILES.WHATSAPP, req.body); cacheVersion = Date.now(); res.json({ success: true }); });
app.post('/api/admin/clear-logs', isAdmin, (req, res) => { writeJSON(FILES.STATS, {}); res.json({ success: true }); });
app.get('/ping', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

app.listen(PORT, () => console.log(`🚀 Running on :${PORT} | Memory Mode Active`));
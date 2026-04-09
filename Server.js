const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper for IP tracking
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

// ========== PERSISTENT STORAGE ==========
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

// JSON Database Files
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const STATS_FILE = path.join(DATA_DIR, 'stats_aggregated.json');
const LEARNING_AREAS_FILE = path.join(DATA_DIR, 'learning_areas.json');
const TERM_SETTINGS_FILE = path.join(DATA_DIR, 'term_settings.json');

const readJSON = (file, def = []) => {
    if (!fs.existsSync(file)) return def;
    try { return JSON.parse(fs.readFileSync(file)); } catch { return def; }
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Memory Caches
const pendingPayments = new Map();
const verifiedPayments = new Map();
const downloadTokens = new Map();

// ========== MULTER CONFIG ==========
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
});
const upload = multer({ storage });

// ========== PAYNECTA CONFIG ==========
const PAYNECTA_API_URL = 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE;

// ========== ADMIN ENDPOINTS ==========
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === '0726019859') {
        res.json({ success: true, token: 'ADMIN_' + Date.now() });
    } else {
        res.status(401).json({ success: false });
    }
});

app.get('/api/admin/products', (req, res) => res.json(readJSON(PRODUCTS_FILE)));
app.post('/api/admin/products', upload.single('pdfFile'), (req, res) => {
    const { title, grade, term, subject, price } = req.body;
    const products = readJSON(PRODUCTS_FILE);
    const newProduct = {
        id: Date.now(),
        title, grade, term: parseInt(term), subject,
        price: parseInt(price),
        fileUrl: `/uploads/${req.file.filename}`,
        visible: true
    };
    products.push(newProduct);
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
});

app.delete('/api/admin/products/:id', (req, res) => {
    let products = readJSON(PRODUCTS_FILE);
    products = products.filter(p => p.id !== parseInt(req.params.id));
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
});

app.get('/api/admin/learning-areas', (req, res) => res.json(readJSON(LEARNING_AREAS_FILE)));
app.post('/api/admin/learning-areas', (req, res) => {
    const areas = readJSON(LEARNING_AREAS_FILE);
    areas.push({ id: Date.now(), name: req.body.name });
    writeJSON(LEARNING_AREAS_FILE, areas);
    res.json({ success: true });
});

// ========== CUSTOMER ENDPOINTS ==========
app.get('/api/products', (req, res) => res.json(readJSON(PRODUCTS_FILE)));
app.get('/api/learning-areas', (req, res) => res.json(readJSON(LEARNING_AREAS_FILE)));
app.get('/api/term-settings', (req, res) => res.json(readJSON(TERM_SETTINGS_FILE, {term1:true,term2:true,term3:true})));

app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, productId } = req.body;
    let cleanPhone = phone.replace(/\s/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.substring(1);

    const txnId = 'TXN_' + Date.now();
    const products = readJSON(PRODUCTS_FILE);
    const product = products.find(p => p.id === parseInt(productId));
    if (!product) return res.status(404).json({ error: 'Product not found' });

    pendingPayments.set(txnId, { 
        productId: product.id, amount, fileUrl: product.fileUrl, 
        title: product.title, timestamp: Date.now(), status: 'pending' 
    });

    if (!PAYNECTA_API_KEY) {
        console.log("Demo Mode Active: No API Key provided.");
        return res.json({ success: true, transactionId: txnId });
    }

    try {
        const response = await axios.post(`${PAYNECTA_API_URL}/payment/initialize`, {
            code: PAYNECTA_PAYMENT_CODE, mobile_number: cleanPhone, amount: parseInt(amount)
        }, { headers: { 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL } });

        if (response.data.success) {
            const p = pendingPayments.get(txnId);
            p.paynectaRef = response.data.data.transaction_reference;
            res.json({ success: true, transactionId: txnId });
        } else {
            res.status(400).json({ error: response.data.message });
        }
    } catch (e) { res.status(500).json({ error: 'Payment Initialization Failed' }); }
});

app.get('/api/payment-status/:txnId', async (req, res) => {
    const { txnId } = req.params;
    const p = pendingPayments.get(txnId);
    if (!p) return res.json({ status: 'not_found' });

    // Demo Mode: Auto confirm after 12 seconds
    if (!PAYNECTA_API_KEY && (Date.now() - p.timestamp > 12000)) p.status = 'success';

    if (p.status === 'success') {
        const token = 'VER_' + Math.random().toString(36).substr(2);
        verifiedPayments.set(token, { ...p, expires: Date.now() + 600000 });
        pendingPayments.delete(txnId);
        return res.json({ status: 'success', verified: true, token });
    }
    res.json({ status: 'pending' });
});

app.post('/api/request-download', (req, res) => {
    const { verificationToken, productId } = req.body;
    const v = verifiedPayments.get(verificationToken);
    if (!v || v.productId !== parseInt(productId)) return res.status(403).json({ error: 'Invalid Session' });

    const dlToken = 'DL_' + Math.random().toString(36).substr(2);
    downloadTokens.set(dlToken, { fileUrl: v.fileUrl, title: v.title, expires: Date.now() + 120000 });
    verifiedPayments.delete(verificationToken);
    res.json({ success: true, token: dlToken });
});

app.get('/api/download/:token', (req, res) => {
    const d = downloadTokens.get(req.params.token);
    if (!d || d.expires < Date.now()) return res.status(403).send('Link Expired');

    const filename = d.fileUrl.split('/').pop();
    const filePath = path.join(UPLOAD_DIR, filename);

    if (fs.existsSync(filePath)) {
        res.download(filePath, `${d.title}${path.extname(filename)}`);
        downloadTokens.delete(req.params.token);
    } else {
        res.status(404).send('File missing on server');
    }
});

app.post('/api/track-visit', (req, res) => { res.json({ success: true }); });

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

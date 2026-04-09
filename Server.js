const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== STORAGE SETUP ==========
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOAD_DIR));

const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const AREAS_FILE = path.join(DATA_DIR, 'learning_areas.json');

const readJSON = (f, d = []) => {
    if (!fs.existsSync(f)) return d;
    try { return JSON.parse(fs.readFileSync(f)); } catch { return d; }
};
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
});
const upload = multer({ storage });

const pendingPayments = new Map();
const verifiedPayments = new Map();
const downloadTokens = new Map();

// ========== ADMIN ROUTES ==========
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === '0726019859') res.json({ success: true, token: 'ADM-' + Date.now() });
    else res.status(401).json({ success: false });
});

app.get('/api/admin/products', (req, res) => res.json(readJSON(PRODUCTS_FILE)));
app.get('/api/admin/learning-areas', (req, res) => res.json(readJSON(AREAS_FILE)));

app.post('/api/admin/products', upload.single('pdfFile'), (req, res) => {
    const products = readJSON(PRODUCTS_FILE);
    const newP = {
        id: Date.now(),
        title: req.body.title,
        grade: req.body.grade,
        term: parseInt(req.body.term),
        subject: req.body.subject,
        price: parseInt(req.body.price),
        visible: req.body.visible === 'true' || req.body.visible === true,
        fileUrl: `/uploads/${req.file.filename}`
    };
    products.push(newP);
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
});

app.put('/api/admin/products/:id', (req, res) => {
    let products = readJSON(PRODUCTS_FILE);
    const idx = products.findIndex(p => p.id === parseInt(req.params.id));
    if (idx !== -1) {
        products[idx] = { ...products[idx], ...req.body };
        writeJSON(PRODUCTS_FILE, products);
        res.json({ success: true });
    } else res.status(404).json({ error: 'Not found' });
});

app.delete('/api/admin/products/:id', (req, res) => {
    let products = readJSON(PRODUCTS_FILE);
    products = products.filter(p => p.id !== parseInt(req.params.id));
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
});

app.post('/api/admin/learning-areas', (req, res) => {
    const areas = readJSON(AREAS_FILE);
    areas.push({ id: Date.now(), name: req.body.name });
    writeJSON(AREAS_FILE, areas);
    res.json({ success: true });
});

app.delete('/api/admin/learning-areas/:id', (req, res) => {
    let areas = readJSON(AREAS_FILE);
    areas = areas.filter(a => a.id !== parseInt(req.params.id));
    writeJSON(AREAS_FILE, areas);
    res.json({ success: true });
});

// ========== CUSTOMER ROUTES ==========
app.get('/api/products', (req, res) => {
    res.json(readJSON(PRODUCTS_FILE).filter(p => p.visible !== false));
});

app.get('/api/learning-areas', (req, res) => res.json(readJSON(AREAS_FILE)));

app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, productId } = req.body;
    const txnId = 'TXN_' + Date.now();
    const product = readJSON(PRODUCTS_FILE).find(p => p.id === parseInt(productId));
    if (!product) return res.status(404).json({ error: 'Product not found' });

    pendingPayments.set(txnId, { productId: product.id, amount, fileUrl: product.fileUrl, title: product.title, timestamp: Date.now(), status: 'pending' });

    if (!process.env.PAYNECTA_API_KEY) return res.json({ success: true, transactionId: txnId });

    try {
        const response = await axios.post('https://paynecta.co.ke/api/v1/payment/initialize', {
            code: process.env.PAYNECTA_PAYMENT_CODE,
            mobile_number: phone.replace(/^0/, '254'),
            amount: parseInt(amount)
        }, { headers: { 'X-API-Key': process.env.PAYNECTA_API_KEY, 'X-User-Email': process.env.PAYNECTA_EMAIL } });
        res.json({ success: true, transactionId: txnId });
    } catch (e) { res.status(500).json({ error: 'STK Push Failed' }); }
});

app.get('/api/payment-status/:txnId', (req, res) => {
    const p = pendingPayments.get(req.params.txnId);
    if (!p) return res.json({ status: 'not_found' });
    if (!process.env.PAYNECTA_API_KEY && (Date.now() - p.timestamp > 10000)) p.status = 'success';

    if (p.status === 'success') {
        const vToken = 'VER_' + Math.random().toString(36).substr(2);
        verifiedPayments.set(vToken, { ...p, expires: Date.now() + 600000 });
        pendingPayments.delete(req.params.txnId);
        return res.json({ status: 'success', verified: true, token: vToken });
    }
    res.json({ status: 'pending' });
});

app.post('/api/request-download', (req, res) => {
    const { verificationToken, productId } = req.body;
    const v = verifiedPayments.get(verificationToken);
    if (!v || v.productId !== parseInt(productId)) return res.status(403).json({ error: 'Session Expired' });

    const dlToken = 'DL_' + Math.random().toString(36).substr(2);
    downloadTokens.set(dlToken, { fileUrl: v.fileUrl, title: v.title, expires: Date.now() + 120000 });
    res.json({ success: true, token: dlToken });
});

app.get('/api/download/:token', (req, res) => {
    const d = downloadTokens.get(req.params.token);
    if (!d || d.expires < Date.now()) return res.status(403).send('Expired');
    const filename = d.fileUrl.split('/').pop();
    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath, `${d.title}${path.extname(filename)}`);
        downloadTokens.delete(req.params.token);
    } else res.status(404).send('File missing');
});

app.get('/api/term-settings', (req, res) => res.json({term1:true, term2:true, term3:true}));

app.listen(PORT, () => console.log(`Server live on ${PORT}`));

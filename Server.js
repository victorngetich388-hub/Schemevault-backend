const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------
// Local Storage Setup
// ------------------------------
const UPLOAD_DIR = 'uploads';
const COVERS_DIR = 'covers';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR);

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'coverImage') cb(null, COVERS_DIR);
        else cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, '_');
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

// ------------------------------
// Data Files
// ------------------------------
const PRODUCTS_FILE = 'products.json';
const STATS_FILE = 'stats.json';
const MESSAGES_FILE = 'messages.json';
const ACTIVITY_FILE = 'activity.json';

const readJSON = (file, defaultVal = []) => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultVal));
        return defaultVal;
    }
    return JSON.parse(fs.readFileSync(file));
};

const writeJSON = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// ------------------------------
// Admin Authentication
// ------------------------------
const ADMIN_PASSWORD = '0726019859'; // Hardcoded for reliability
const RECOVERY_EMAIL = 'victorngetich388@gmail.com';
let resetCodes = {};

// Email setup (optional – for password reset)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || RECOVERY_EMAIL,
        pass: process.env.EMAIL_PASS,
    },
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = Buffer.from(Date.now().toString()).toString('base64');
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Wrong password' });
    }
});

function isAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (token) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/forgot-password', async (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes[code] = Date.now() + 3600000;
    try {
        await transporter.sendMail({
            from: `"SchemeVault Admin" <${RECOVERY_EMAIL}>`,
            to: RECOVERY_EMAIL,
            subject: 'Admin Password Reset Code',
            text: `Your reset code is: ${code}\nIt expires in 1 hour.`,
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Email not configured. Use password: 0726019859' });
    }
});

app.post('/api/admin/reset-password', (req, res) => {
    const { code, newPassword } = req.body;
    if (!resetCodes[code] || resetCodes[code] < Date.now()) {
        return res.status(400).json({ error: 'Invalid or expired code' });
    }
    delete resetCodes[code];
    res.json({ success: true, message: 'Password reset. Update your code manually.' });
});

// ------------------------------
// Product Management
// ------------------------------
app.get('/api/admin/products', isAdmin, (req, res) => {
    const products = readJSON(PRODUCTS_FILE, []);
    res.json(products);
});

app.post('/api/admin/products', isAdmin, upload.fields([{ name: 'pdfFile' }, { name: 'coverImage' }]), (req, res) => {
    try {
        const { title, grade, term, subject, price, pages, visible } = req.body;
        if (!title || !grade || !term || !subject || !price) {
            return res.status(400).json({ error: 'All fields required' });
        }
        const pdfFile = req.files['pdfFile'] ? req.files['pdfFile'][0] : null;
        const coverFile = req.files['coverImage'] ? req.files['coverImage'][0] : null;
        if (!pdfFile) return res.status(400).json({ error: 'PDF file required' });

        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${pdfFile.filename}`;
        const coverUrl = coverFile ? `${req.protocol}://${req.get('host')}/covers/${coverFile.filename}` : null;

        const products = readJSON(PRODUCTS_FILE, []);
        const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
        const newProduct = {
            id: newId,
            title,
            grade,
            term: parseInt(term),
            subject,
            price: parseInt(price),
            pages: pages ? parseInt(pages) : null,
            fileUrl,
            coverUrl,
            visible: visible === 'true' || visible === true,
            createdAt: new Date().toISOString(),
        };
        products.push(newProduct);
        writeJSON(PRODUCTS_FILE, products);
        console.log(`Product added: ${newProduct.title} (ID: ${newId})`);
        res.json({ success: true, product: newProduct });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.put('/api/admin/products/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const updates = req.body;
    let products = readJSON(PRODUCTS_FILE, []);
    const index = products.findIndex(p => p.id === id);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    products[index] = { ...products[index], ...updates };
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
});

app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === id);
    if (product) {
        if (product.fileUrl) {
            const filename = product.fileUrl.split('/').pop();
            const filePath = path.join(UPLOAD_DIR, filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        if (product.coverUrl) {
            const filename = product.coverUrl.split('/').pop();
            const filePath = path.join(COVERS_DIR, filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }
    products = products.filter(p => p.id !== id);
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
});

// ------------------------------
// Secure Download (hide real URL)
// ------------------------------
const downloadTokens = {};

app.post('/api/request-download', (req, res) => {
    const { productId, paymentRef } = req.body;
    if (!productId || !paymentRef) {
        return res.status(400).json({ error: 'Missing productId or paymentRef' });
    }
    const token = Math.random().toString(36).substring(2, 15);
    downloadTokens[token] = { productId, expires: Date.now() + 60000 };
    res.json({ token });
});

app.get('/api/download/:token', async (req, res) => {
    const { token } = req.params;
    const record = downloadTokens[token];
    if (!record || record.expires < Date.now()) {
        return res.status(404).send('Download link expired');
    }
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === record.productId);
    if (!product || !product.fileUrl) {
        return res.status(404).send('File not found');
    }
    try {
        const response = await axios({ method: 'GET', url: product.fileUrl, responseType: 'stream' });
        res.setHeader('Content-Disposition', `attachment; filename="${product.title.replace(/ /g, '_')}.pdf"`);
        response.data.pipe(res);
        delete downloadTokens[token];
    } catch (err) {
        console.error(err);
        res.status(500).send('Error downloading file');
    }
});

// ------------------------------
// Analytics & Public Endpoints
// ------------------------------
app.get('/api/products', (req, res) => {
    const products = readJSON(PRODUCTS_FILE, []);
    const visible = products.filter(p => p.visible !== false);
    res.json(visible);
});

app.get('/api/messages', (req, res) => {
    const messages = readJSON(MESSAGES_FILE, []);
    const now = new Date();
    const active = messages.filter(m => m.active && new Date(m.startDate) <= now && (!m.endDate || new Date(m.endDate) >= now));
    res.json(active);
});

// Track visit with IP and timestamp
app.post('/api/track-visit', (req, res) => {
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const visit = {
        date: new Date().toISOString(),
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
        userAgent: req.headers['user-agent']
    };
    stats.visits.push(visit);
    writeJSON(STATS_FILE, stats);

    const activity = readJSON(ACTIVITY_FILE, []);
    activity.push({
        id: Date.now(),
        type: 'visit',
        data: { ip: visit.ip, userAgent: visit.userAgent },
        timestamp: visit.date
    });
    writeJSON(ACTIVITY_FILE, activity.slice(-1000));
    res.json({ success: true });
});

app.post('/api/track-download', (req, res) => {
    const { productId, productName, price } = req.body;
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    stats.downloads.push({
        date: new Date().toISOString(),
        productId, productName, price,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
    writeJSON(STATS_FILE, stats);

    const activity = readJSON(ACTIVITY_FILE, []);
    activity.push({
        id: Date.now(),
        type: 'download',
        data: { productName, price },
        timestamp: new Date().toISOString()
    });
    writeJSON(ACTIVITY_FILE, activity.slice(-1000));
    res.json({ success: true });
});

// ------------------------------
// Admin Analytics
// ------------------------------
app.get('/api/admin/stats', isAdmin, (req, res) => {
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const activity = readJSON(ACTIVITY_FILE, []);
    const totalVisits = stats.visits.length;
    const totalDownloads = stats.downloads.length;
    const successfulPayments = stats.payments?.filter(p => p.status === 'success').length || 0;
    const cancelledPayments = stats.payments?.filter(p => p.status === 'failed' || p.status === 'cancelled').length || 0;

    const productCount = {};
    stats.downloads.forEach(d => {
        productCount[d.productName] = (productCount[d.productName] || 0) + 1;
    });
    const topProducts = Object.entries(productCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    // Group visits by date (last 7 days)
    const visitsByDay = {};
    stats.visits.forEach(v => {
        const date = v.date.split('T')[0];
        visitsByDay[date] = (visitsByDay[date] || 0) + 1;
    });
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        last7Days.push({ date: dateStr, visits: visitsByDay[dateStr] || 0 });
    }

    res.json({
        summary: {
            totalVisits,
            totalDownloads,
            successfulPayments,
            cancelledPayments,
            conversionRate: totalVisits ? ((successfulPayments / totalVisits) * 100).toFixed(1) : 0,
        },
        topProducts,
        visitsByDay: last7Days,
        recentActivity: activity.slice(-20).reverse(),
        recentVisits: stats.visits.slice(-10).reverse()
    });
});

app.get('/api/admin/activity', isAdmin, (req, res) => {
    const activity = readJSON(ACTIVITY_FILE, []);
    const { type } = req.query;
    let filtered = activity;
    if (type) filtered = activity.filter(a => a.type === type);
    res.json(filtered.slice(-100).reverse());
});

// ------------------------------
// Scheduled Messages
// ------------------------------
app.get('/api/admin/messages', isAdmin, (req, res) => {
    res.json(readJSON(MESSAGES_FILE, []));
});

app.post('/api/admin/messages', isAdmin, (req, res) => {
    const { title, content, type, startDate, endDate, isActive } = req.body;
    const messages = readJSON(MESSAGES_FILE, []);
    const newMsg = {
        id: Date.now(),
        title, content, type: type || 'banner',
        startDate: new Date(startDate).toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : null,
        active: isActive === true || isActive === 'true',
        createdAt: new Date().toISOString(),
    };
    messages.push(newMsg);
    writeJSON(MESSAGES_FILE, messages);
    res.json({ success: true, message: newMsg });
});

app.put('/api/admin/messages/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { active } = req.body;
    let messages = readJSON(MESSAGES_FILE, []);
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    messages[idx].active = active;
    writeJSON(MESSAGES_FILE, messages);
    res.json({ success: true });
});

app.delete('/api/admin/messages/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let messages = readJSON(MESSAGES_FILE, []);
    messages = messages.filter(m => m.id !== id);
    writeJSON(MESSAGES_FILE, messages);
    res.json({ success: true });
});

// ------------------------------
// Payment Endpoint (Placeholder)
// ------------------------------
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount } = req.body;
    console.log(`Payment request: ${phone}, KES ${amount}`);
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    if (!stats.payments) stats.payments = [];
    stats.payments.push({
        date: new Date().toISOString(),
        status: 'success',
        amount,
        phone,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
    writeJSON(STATS_FILE, stats);
    res.json({ success: true, checkoutRequestId: 'demo_' + Date.now() });
});

app.post('/api/payment-webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    res.sendStatus(200);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
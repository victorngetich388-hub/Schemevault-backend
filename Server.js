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
// Data Files (JSON)
// ------------------------------
const PRODUCTS_FILE = 'products.json';
const STATS_FILE = 'stats.json';
const MESSAGES_FILE = 'messages.json';
const ACTIVITY_FILE = 'activity.json';
const CLIENTS_FILE = 'clients.json';
const FEEDBACK_FILE = 'feedback.json';
const TERM_SETTINGS_FILE = 'term_settings.json';
const BANNER_FILE = 'banner.json';
const WHATSAPP_FILE = 'whatsapp.json';
const POPUPS_FILE = 'popups.json';
const LEARNING_AREAS_FILE = 'learning_areas.json';
const GRADES_FILE = 'grades.json';

const readJSON = (file, defaultVal = []) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultVal));
    return JSON.parse(fs.readFileSync(file));
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

function getStorageUsage() {
    const getSize = (dir) => {
        let size = 0;
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isFile()) size += stat.size;
                else if (stat.isDirectory()) size += getSize(filePath);
            }
        }
        return size;
    };
    const uploadsSize = getSize(UPLOAD_DIR);
    const coversSize = getSize(COVERS_DIR);
    const totalMB = ((uploadsSize + coversSize) / (1024 * 1024)).toFixed(2);
    return { usedMB: totalMB, usedBytes: uploadsSize + coversSize };
}

// ------------------------------
// Default Data
// ------------------------------
const defaultLearningAreas = [
    { id: 1, name: "Mathematics", active: true, order: 1 },
    { id: 2, name: "English", active: true, order: 2 },
    { id: 3, name: "Kiswahili", active: true, order: 3 },
    { id: 4, name: "Creative Arts", active: true, order: 4 },
    { id: 5, name: "Social Studies", active: true, order: 5 },
    { id: 6, name: "Integrated Science", active: true, order: 6 },
    { id: 7, name: "Pre-technical Studies", active: true, order: 7 },
    { id: 8, name: "Agriculture", active: true, order: 8 }
];

const defaultGrades = [
    { id: 1, name: "Grade 1", active: true, order: 1 },
    { id: 2, name: "Grade 2", active: true, order: 2 },
    { id: 3, name: "Grade 3", active: true, order: 3 },
    { id: 4, name: "Grade 4", active: true, order: 4 },
    { id: 5, name: "Grade 5", active: true, order: 5 },
    { id: 6, name: "Grade 6", active: true, order: 6 },
    { id: 7, name: "Grade 7", active: true, order: 7 },
    { id: 8, name: "Grade 8", active: true, order: 8 },
    { id: 9, name: "Grade 9", active: true, order: 9 }
];

// ------------------------------
// Active Users Tracking
// ------------------------------
const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, data] of activeSessions.entries()) {
        if (now - data.lastSeen > 60000) activeSessions.delete(sessionId);
    }
}, 30000);

let cacheVersion = Date.now();

// Payment storage
const verifiedPayments = new Map();
const downloadTokens = new Map();

// ------------------------------
// Admin Authentication
// ------------------------------
const ADMIN_PASSWORD = '0726019859';
const RECOVERY_EMAIL = 'victorngetich388@gmail.com';
let resetCodes = {};

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
        res.status(500).json({ error: 'Failed to send email' });
    }
});

app.post('/api/admin/reset-password', (req, res) => {
    const { code, newPassword } = req.body;
    if (!resetCodes[code] || resetCodes[code] < Date.now()) {
        return res.status(400).json({ error: 'Invalid code' });
    }
    delete resetCodes[code];
    res.json({ success: true, message: 'Password reset. Update your code manually.' });
});

app.post('/api/admin/change-password', isAdmin, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Current password incorrect' });
    res.json({ success: true, message: 'Change requested. Update Render environment variable.' });
});

app.get('/api/cache-version', (req, res) => {
    res.json({ version: cacheVersion });
});

app.post('/api/admin/clear-cache', isAdmin, (req, res) => {
    cacheVersion = Date.now();
    res.json({ success: true, version: cacheVersion });
});

// ------------------------------
// Active Users Endpoints
// ------------------------------
app.post('/api/heartbeat', (req, res) => {
    const { sessionId } = req.body;
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    activeSessions.set(sessionId, { ip, userAgent, lastSeen: Date.now(), firstSeen: activeSessions.has(sessionId) ? activeSessions.get(sessionId).firstSeen : Date.now() });
    res.json({ success: true, activeCount: activeSessions.size });
});

app.get('/api/admin/active-users', isAdmin, (req, res) => {
    const now = Date.now();
    let active = 0;
    const activeList = [];
    for (const [sessionId, data] of activeSessions.entries()) {
        if (now - data.lastSeen <= 60000) {
            active++;
            activeList.push({ sessionId: sessionId.substring(0, 8), ip: data.ip, lastSeen: data.lastSeen, activeSeconds: Math.floor((now - data.lastSeen) / 1000), duration: Math.floor((now - data.firstSeen) / 1000) });
        }
    }
    res.json({ activeCount: active, activeUsers: activeList, lastUpdated: new Date().toISOString() });
});

app.post('/api/leave', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && activeSessions.has(sessionId)) activeSessions.delete(sessionId);
    res.json({ success: true });
});

// ------------------------------
// Learning Areas Management
// ------------------------------
app.get('/api/admin/learning-areas', isAdmin, (req, res) => {
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    if (areas.length === 0) { areas = defaultLearningAreas; writeJSON(LEARNING_AREAS_FILE, areas); }
    res.json(areas);
});
app.get('/api/learning-areas', (req, res) => {
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    if (areas.length === 0) { areas = defaultLearningAreas; writeJSON(LEARNING_AREAS_FILE, areas); }
    res.json(areas.filter(area => area.active === true));
});
app.post('/api/admin/learning-areas', isAdmin, (req, res) => {
    const { name, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    const newId = areas.length ? Math.max(...areas.map(a => a.id)) + 1 : 1;
    const newArea = { id: newId, name, active: active === true || active === 'true', order: areas.length + 1 };
    areas.push(newArea);
    writeJSON(LEARNING_AREAS_FILE, areas);
    cacheVersion = Date.now();
    res.json({ success: true, area: newArea });
});
app.put('/api/admin/learning-areas/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { name, active } = req.body;
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    const index = areas.findIndex(a => a.id === id);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    if (name !== undefined) areas[index].name = name;
    if (active !== undefined) areas[index].active = active === true || active === 'true';
    writeJSON(LEARNING_AREAS_FILE, areas);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.delete('/api/admin/learning-areas/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    areas = areas.filter(a => a.id !== id);
    writeJSON(LEARNING_AREAS_FILE, areas);
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ------------------------------
// Grades Management
// ------------------------------
app.get('/api/admin/grades', isAdmin, (req, res) => {
    let grades = readJSON(GRADES_FILE, []);
    if (grades.length === 0) { grades = defaultGrades; writeJSON(GRADES_FILE, grades); }
    res.json(grades);
});
app.get('/api/grades', (req, res) => {
    let grades = readJSON(GRADES_FILE, []);
    if (grades.length === 0) { grades = defaultGrades; writeJSON(GRADES_FILE, grades); }
    res.json(grades.filter(grade => grade.active === true));
});
app.post('/api/admin/grades', isAdmin, (req, res) => {
    const { name, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let grades = readJSON(GRADES_FILE, []);
    const newId = grades.length ? Math.max(...grades.map(g => g.id)) + 1 : 1;
    const newGrade = { id: newId, name, active: active === true || active === 'true', order: grades.length + 1 };
    grades.push(newGrade);
    writeJSON(GRADES_FILE, grades);
    cacheVersion = Date.now();
    res.json({ success: true, grade: newGrade });
});
app.put('/api/admin/grades/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { name, active } = req.body;
    let grades = readJSON(GRADES_FILE, []);
    const index = grades.findIndex(g => g.id === id);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    if (name !== undefined) grades[index].name = name;
    if (active !== undefined) grades[index].active = active === true || active === 'true';
    writeJSON(GRADES_FILE, grades);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.delete('/api/admin/grades/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let grades = readJSON(GRADES_FILE, []);
    grades = grades.filter(g => g.id !== id);
    writeJSON(GRADES_FILE, grades);
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ------------------------------
// IP Geolocation (optional)
// ------------------------------
app.get('/api/geo/:ip', async (req, res) => {
    const ip = req.params.ip;
    if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
        return res.json({ ip, city: 'Local', region: 'Local', country: 'Local' });
    }
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp`);
        if (response.data.status === 'success') {
            res.json({ ip, city: response.data.city, region: response.data.regionName, country: response.data.country, isp: response.data.isp });
        } else {
            res.json({ ip, city: 'Unknown', region: 'Unknown', country: 'Unknown' });
        }
    } catch (error) {
        res.json({ ip, city: 'Error', region: 'Error', country: 'Error' });
    }
});

app.get('/api/admin/visitors-with-location', isAdmin, async (req, res) => {
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const recentIPs = [...new Set(stats.visits.slice(-50).map(v => v.ip))];
    const locations = [];
    for (const ip of recentIPs) {
        try {
            const geoRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp`);
            if (geoRes.data.status === 'success') {
                locations.push({ ip, city: geoRes.data.city, region: geoRes.data.regionName, country: geoRes.data.country, isp: geoRes.data.isp });
            } else {
                locations.push({ ip, city: 'Unknown', region: 'Unknown', country: 'Unknown' });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
            locations.push({ ip, city: 'Error', region: 'Error', country: 'Error' });
        }
    }
    res.json(locations);
});

// ------------------------------
// Term Settings
// ------------------------------
app.get('/api/admin/term-settings', isAdmin, (req, res) => {
    res.json(readJSON(TERM_SETTINGS_FILE, { term1: true, term2: true, term3: true }));
});
app.put('/api/admin/term-settings', isAdmin, (req, res) => {
    const settings = req.body;
    writeJSON(TERM_SETTINGS_FILE, settings);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.get('/api/term-settings', (req, res) => {
    res.json(readJSON(TERM_SETTINGS_FILE, { term1: true, term2: true, term3: true }));
});

// ------------------------------
// Product Management
// ------------------------------
app.get('/api/admin/products', isAdmin, (req, res) => {
    res.json(readJSON(PRODUCTS_FILE, []));
});

app.post('/api/admin/products', isAdmin, upload.fields([{ name: 'pdfFile' }, { name: 'coverImage' }]), (req, res) => {
    try {
        const { title, grade, term, subject, price, pages, visible } = req.body;
        if (!title || !grade || !term || !subject || !price) return res.status(400).json({ error: 'All fields required' });
        const pdfFile = req.files['pdfFile'] ? req.files['pdfFile'][0] : null;
        const coverFile = req.files['coverImage'] ? req.files['coverImage'][0] : null;
        if (!pdfFile) return res.status(400).json({ error: 'PDF required' });

        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${pdfFile.filename}`;
        const coverUrl = coverFile ? `${req.protocol}://${req.get('host')}/covers/${coverFile.filename}` : null;

        const products = readJSON(PRODUCTS_FILE, []);
        const newId = products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;
        const newProduct = {
            id: newId, title, grade, term: parseInt(term), subject,
            price: parseInt(price), pages: pages ? parseInt(pages) : null,
            fileUrl, coverUrl, visible: visible === 'true' || visible === true,
            createdAt: new Date().toISOString(),
        };
        products.push(newProduct);
        writeJSON(PRODUCTS_FILE, products);
        cacheVersion = Date.now();
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
    cacheVersion = Date.now();
    res.json({ success: true, product: products[index] });
});

app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === id);
    if (product) {
        if (product.fileUrl) {
            const filename = product.fileUrl.split('/').pop();
            const fpath = path.join(UPLOAD_DIR, filename);
            if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        }
        if (product.coverUrl) {
            const filename = product.coverUrl.split('/').pop();
            const fpath = path.join(COVERS_DIR, filename);
            if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        }
    }
    products = products.filter(p => p.id !== id);
    writeJSON(PRODUCTS_FILE, products);
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ------------------------------
// BACKUP & RESTORE (No external cloud)
// ------------------------------
app.get('/api/admin/backup', isAdmin, (req, res) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment('schemevault-backup.zip');
    archive.pipe(res);

    const jsonFiles = [PRODUCTS_FILE, STATS_FILE, MESSAGES_FILE, ACTIVITY_FILE, CLIENTS_FILE, FEEDBACK_FILE, TERM_SETTINGS_FILE, BANNER_FILE, WHATSAPP_FILE, POPUPS_FILE, LEARNING_AREAS_FILE, GRADES_FILE];
    jsonFiles.forEach(file => {
        if (fs.existsSync(file)) {
            archive.file(file, { name: `data/${file}` });
        }
    });

    if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');
    if (fs.existsSync(COVERS_DIR)) archive.directory(COVERS_DIR, 'covers');

    archive.finalize();
});

app.post('/api/admin/restore', isAdmin, upload.single('backupFile'), async (req, res) => {
    const zipFile = req.file;
    if (!zipFile) return res.status(400).json({ error: 'No file uploaded' });
    const extractPath = path.join(__dirname, 'restore_temp');
    if (!fs.existsSync(extractPath)) fs.mkdirSync(extractPath);

    try {
        await extract(zipFile.path, { dir: extractPath });
        // Restore JSON files
        const dataDir = path.join(extractPath, 'data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            for (const file of files) {
                const src = path.join(dataDir, file);
                const dest = path.join(__dirname, file);
                fs.copyFileSync(src, dest);
            }
        }
        // Restore uploads
        const uploadsBackup = path.join(extractPath, 'uploads');
        if (fs.existsSync(uploadsBackup)) {
            const files = fs.readdirSync(uploadsBackup);
            for (const file of files) {
                const src = path.join(uploadsBackup, file);
                const dest = path.join(UPLOAD_DIR, file);
                fs.copyFileSync(src, dest);
            }
        }
        const coversBackup = path.join(extractPath, 'covers');
        if (fs.existsSync(coversBackup)) {
            const files = fs.readdirSync(coversBackup);
            for (const file of files) {
                const src = path.join(coversBackup, file);
                const dest = path.join(COVERS_DIR, file);
                fs.copyFileSync(src, dest);
            }
        }
        fs.rmSync(extractPath, { recursive: true, force: true });
        fs.unlinkSync(zipFile.path);
        cacheVersion = Date.now();
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Restore failed' });
    }
});

// ------------------------------
// PAYMENT ENDPOINTS (FAST CONFIRMATION)
// ------------------------------
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, productId } = req.body;
    if (!phone || !amount || !productId) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    let cleanPhone = phone.replace(/\s/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.substring(1);
    else if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
    const transactionId = 'TXN_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    try {
        const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://api.paynecta.co.ke';
        const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
        const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
        const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE;

        if (!PAYNECTA_API_KEY || !PAYNECTA_EMAIL || !PAYNECTA_PAYMENT_CODE) {
            // Demo mode: auto-confirm after 2 seconds
            setTimeout(() => {
                const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
                const pIndex = stats.payments.findIndex(p => p.transactionId === transactionId);
                if (pIndex !== -1) {
                    stats.payments[pIndex].status = 'success';
                    writeJSON(STATS_FILE, stats);
                    const verifyToken = 'DEMO_' + Date.now();
                    verifiedPayments.set(verifyToken, { productId, transactionId, amount, expires: Date.now() + 300000 });
                }
            }, 2000);
            const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
            if (!stats.payments) stats.payments = [];
            stats.payments.push({ date: new Date().toISOString(), status: 'pending', amount, phone: cleanPhone, productId, transactionId, ip: getClientIp(req) });
            writeJSON(STATS_FILE, stats);
            return res.json({ success: true, transactionId });
        }

        const response = await axios.post(
            `${PAYNECTA_API_URL}/api/v1/payment/initialize`,
            { code: PAYNECTA_PAYMENT_CODE, mobile_number: cleanPhone, amount: amount },
            { headers: { 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        if (response.data && response.data.success) {
            const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
            if (!stats.payments) stats.payments = [];
            stats.payments.push({ date: new Date().toISOString(), status: 'pending', amount, phone: cleanPhone, productId, transactionId, ip: getClientIp(req) });
            writeJSON(STATS_FILE, stats);
            res.json({ success: true, transactionId });
        } else {
            res.status(400).json({ success: false, error: response.data?.message || 'Payment initiation failed' });
        }
    } catch (error) {
        console.error('Paynecta error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/payment-status/:transactionId', (req, res) => {
    const { transactionId } = req.params;
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const payment = stats.payments.find(p => p.transactionId === transactionId);
    if (!payment) return res.json({ status: 'not_found', verified: false });
    if (payment.status === 'success') {
        let verifyToken = null;
        for (const [token, data] of verifiedPayments.entries()) {
            if (data.transactionId === transactionId && data.expires > Date.now()) { verifyToken = token; break; }
        }
        if (!verifyToken) {
            verifyToken = 'VER_' + Date.now();
            verifiedPayments.set(verifyToken, { productId: payment.productId, transactionId, amount: payment.amount, expires: Date.now() + 300000 });
        }
        res.json({ status: 'success', verified: true, token: verifyToken });
    } else if (payment.status === 'failed') {
        res.json({ status: 'failed', verified: false });
    } else {
        res.json({ status: 'pending', verified: false });
    }
});

app.post('/api/payment-webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    const { ResultCode, reference } = req.body;
    if (ResultCode === 0) {
        const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
        const pIndex = stats.payments.findIndex(p => p.transactionId === reference);
        if (pIndex !== -1) {
            stats.payments[pIndex].status = 'success';
            writeJSON(STATS_FILE, stats);
            const verifyToken = 'WEB_' + Date.now();
            verifiedPayments.set(verifyToken, { productId: stats.payments[pIndex].productId, transactionId: reference, amount: stats.payments[pIndex].amount, expires: Date.now() + 300000 });
        }
    }
    res.sendStatus(200);
});

app.post('/api/request-download', (req, res) => {
    const { verificationToken, productId } = req.body;
    if (!verificationToken || !productId) return res.status(400).json({ error: 'Missing data' });
    const verifiedData = verifiedPayments.get(verificationToken);
    if (!verifiedData || verifiedData.expires < Date.now()) {
        return res.status(403).json({ error: 'Payment not verified or expired' });
    }
    if (verifiedData.productId !== productId) {
        return res.status(403).json({ error: 'Invalid token' });
    }
    const downloadToken = Math.random().toString(36).substring(2, 15);
    downloadTokens.set(downloadToken, { productId, expires: Date.now() + 60000 });
    verifiedPayments.delete(verificationToken);
    res.json({ success: true, token: downloadToken });
});

app.get('/api/download/:token', async (req, res) => {
    const { token } = req.params;
    const record = downloadTokens.get(token);
    if (!record || record.expires < Date.now()) {
        return res.status(403).send('Download link expired or invalid.');
    }
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === record.productId);
    if (!product || !product.fileUrl) return res.status(404).send('File not found');
    try {
        const response = await axios({ method: 'GET', url: product.fileUrl, responseType: 'stream' });
        res.setHeader('Content-Disposition', `attachment; filename="${product.title.replace(/ /g, '_')}.pdf"`);
        response.data.pipe(res);
        downloadTokens.delete(token);
        const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
        stats.downloads.push({ date: new Date().toISOString(), productId: product.id, productName: product.title, price: product.price, ip: getClientIp(req) });
        writeJSON(STATS_FILE, stats);
    } catch (err) {
        res.status(500).send('Download error');
    }
});

app.post('/api/admin/force-confirm', isAdmin, (req, res) => {
    const { transactionId, productId } = req.body;
    const verifyToken = 'ADMIN_' + Date.now();
    verifiedPayments.set(verifyToken, { productId, transactionId, amount: 0, expires: Date.now() + 300000 });
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const payment = stats.payments.find(p => p.transactionId === transactionId);
    if (payment) payment.status = 'success';
    writeJSON(STATS_FILE, stats);
    res.json({ success: true, token: verifyToken });
});

// ------------------------------
// Public Endpoints
// ------------------------------
app.get('/api/products', (req, res) => {
    const products = readJSON(PRODUCTS_FILE, []);
    res.json(products.filter(p => p.visible !== false));
});

app.get('/api/messages', (req, res) => {
    const messages = readJSON(MESSAGES_FILE, []);
    const now = new Date();
    res.json(messages.filter(m => m.active && new Date(m.startDate) <= now && (!m.endDate || new Date(m.endDate) >= now)));
});

app.get('/api/popups', (req, res) => {
    const popups = readJSON(POPUPS_FILE, []);
    const now = new Date();
    res.json(popups.filter(p => p.active && new Date(p.startDate) <= now && (!p.endDate || new Date(p.endDate) >= now)));
});

app.post('/api/submit-feedback', (req, res) => {
    const { message, whatsapp } = req.body;
    const feedback = readJSON(FEEDBACK_FILE, []);
    feedback.push({ id: Date.now(), message, whatsapp, ip: getClientIp(req), timestamp: new Date().toISOString(), read: false });
    writeJSON(FEEDBACK_FILE, feedback);
    res.json({ success: true });
});

app.post('/api/track-visit', (req, res) => {
    const ip = getClientIp(req);
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    stats.visits.push({ date: new Date().toISOString(), ip });
    writeJSON(STATS_FILE, stats);
    res.json({ success: true });
});

app.post('/api/track-download', (req, res) => {
    const { productId, productName, price } = req.body;
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    stats.downloads.push({ date: new Date().toISOString(), productId, productName, price, ip: getClientIp(req) });
    writeJSON(STATS_FILE, stats);
    res.json({ success: true });
});

// ------------------------------
// Admin Analytics (shortened)
// ------------------------------
app.get('/api/admin/stats', isAdmin, (req, res) => {
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const storage = getStorageUsage();
    res.json({
        summary: {
            totalVisits: stats.visits.length,
            totalDownloads: stats.downloads.length,
            successfulPayments: stats.payments?.filter(p => p.status === 'success').length || 0,
            storageUsed: storage.usedMB
        }
    });
});
app.get('/api/admin/feedback', isAdmin, (req, res) => { res.json(readJSON(FEEDBACK_FILE, [])); });
app.put('/api/admin/feedback/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let feedback = readJSON(FEEDBACK_FILE, []);
    const idx = feedback.findIndex(f => f.id === id);
    if (idx !== -1) { feedback[idx].read = true; writeJSON(FEEDBACK_FILE, feedback); }
    res.json({ success: true });
});

// ------------------------------
// Messages & Popups (shortened)
// ------------------------------
app.get('/api/admin/messages', isAdmin, (req, res) => { res.json(readJSON(MESSAGES_FILE, [])); });
app.post('/api/admin/messages', isAdmin, (req, res) => {
    const { title, content, type, startDate, endDate, isActive } = req.body;
    const messages = readJSON(MESSAGES_FILE, []);
    messages.push({ id: Date.now(), title, content, type: type || 'banner', startDate: new Date(startDate).toISOString(), endDate: endDate ? new Date(endDate).toISOString() : null, active: isActive === true || isActive === 'true', createdAt: new Date().toISOString() });
    writeJSON(MESSAGES_FILE, messages);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.put('/api/admin/messages/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { active } = req.body;
    let messages = readJSON(MESSAGES_FILE, []);
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    messages[idx].active = active;
    writeJSON(MESSAGES_FILE, messages);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.delete('/api/admin/messages/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let messages = readJSON(MESSAGES_FILE, []);
    messages = messages.filter(m => m.id !== id);
    writeJSON(MESSAGES_FILE, messages);
    cacheVersion = Date.now();
    res.json({ success: true });
});

app.post('/api/admin/instant-message', isAdmin, (req, res) => {
    const { content, type } = req.body;
    const messages = readJSON(MESSAGES_FILE, []);
    messages.push({ id: Date.now(), title: 'Instant Announcement', content, type: type || 'banner', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 86400000).toISOString(), active: true, isInstant: true, createdAt: new Date().toISOString() });
    writeJSON(MESSAGES_FILE, messages);
    cacheVersion = Date.now();
    res.json({ success: true });
});

app.post('/api/admin/popups', isAdmin, (req, res) => {
    const { question, options, triggerType, delaySeconds, whatsappCollect } = req.body;
    const popups = readJSON(POPUPS_FILE, []);
    popups.push({ id: Date.now(), question, options: options || [], triggerType: triggerType || 'onload', delaySeconds: delaySeconds || 0, whatsappCollect: whatsappCollect || false, active: true, startDate: new Date().toISOString(), endDate: null, createdAt: new Date().toISOString() });
    writeJSON(POPUPS_FILE, popups);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.get('/api/admin/popups', isAdmin, (req, res) => { res.json(readJSON(POPUPS_FILE, [])); });
app.delete('/api/admin/popups/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let popups = readJSON(POPUPS_FILE, []);
    popups = popups.filter(p => p.id !== id);
    writeJSON(POPUPS_FILE, popups);
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ------------------------------
// Banner & WhatsApp Settings
// ------------------------------
app.get('/api/banner', (req, res) => { res.json(readJSON(BANNER_FILE, { enabled: false, text: '', startDate: null, endDate: null })); });
app.get('/api/admin/banner', isAdmin, (req, res) => { res.json(readJSON(BANNER_FILE, { enabled: false, text: '', startDate: null, endDate: null })); });
app.post('/api/admin/banner', isAdmin, (req, res) => {
    const { enabled, text, startDate, endDate } = req.body;
    writeJSON(BANNER_FILE, { enabled, text, startDate: startDate || null, endDate: endDate || null });
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.get('/api/admin/whatsapp', isAdmin, (req, res) => { res.json(readJSON(WHATSAPP_FILE, { enabled: false, phone: '', message: '' })); });
app.post('/api/admin/whatsapp', isAdmin, (req, res) => {
    const { enabled, phone, message } = req.body;
    writeJSON(WHATSAPP_FILE, { enabled, phone, message });
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ------------------------------
// Clear Logs
// ------------------------------
app.post('/api/admin/clear-logs', isAdmin, (req, res) => {
    writeJSON(ACTIVITY_FILE, []);
    res.json({ success: true });
});

// ------------------------------
// Keep-Alive Ping
// ------------------------------
app.get('/ping', (req, res) => { res.send('OK'); });
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
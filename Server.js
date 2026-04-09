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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========== PERSISTENT STORAGE (Render Disk) ==========
const DATA_DIR = process.env.DATA_DIR || '/opt/render/project/src/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

// ========== FILE UPLOAD ==========
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

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'pdfFile') {
            const allowedTypes = [
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ];
            if (allowedTypes.includes(file.mimetype)) cb(null, true);
            else cb(new Error('Only PDF or Word documents allowed'), false);
        } else if (file.fieldname === 'coverImage') {
            const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
            if (allowed.includes(file.mimetype)) cb(null, true);
            else cb(new Error('Only images allowed'), false);
        } else cb(null, true);
    }
});

// ========== JSON DATA FILES ==========
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const STATS_AGGREGATED_FILE = path.join(DATA_DIR, 'stats_aggregated.json');
const VISIT_LOGS_FILE = path.join(DATA_DIR, 'visit_logs.json');
const DOWNLOAD_LOGS_FILE = path.join(DATA_DIR, 'download_logs.json');
const PAYMENT_LOGS_FILE = path.join(DATA_DIR, 'payment_logs.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const TERM_SETTINGS_FILE = path.join(DATA_DIR, 'term_settings.json');
const DEFAULT_TERM_FILE = path.join(DATA_DIR, 'default_term.json');
const BANNER_FILE = path.join(DATA_DIR, 'banner.json');
const WHATSAPP_FILE = path.join(DATA_DIR, 'whatsapp.json');
const POPUPS_FILE = path.join(DATA_DIR, 'popups.json');
const LEARNING_AREAS_FILE = path.join(DATA_DIR, 'learning_areas.json');
const GRADES_FILE = path.join(DATA_DIR, 'grades.json');

const readJSON = (file, defaultVal = []) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultVal));
    return JSON.parse(fs.readFileSync(file));
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function getAggregatedStats() {
    return readJSON(STATS_AGGREGATED_FILE, { totalVisits: 0, totalDownloads: 0, totalPayments: 0 });
}
function updateAggregatedStats(type) {
    const stats = getAggregatedStats();
    if (type === 'visit') stats.totalVisits++;
    else if (type === 'download') stats.totalDownloads++;
    else if (type === 'payment') stats.totalPayments++;
    writeJSON(STATS_AGGREGATED_FILE, stats);
}

async function getClientInfo(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    let device = 'Desktop';
    if (/mobile/i.test(userAgent)) device = 'Mobile';
    else if (/tablet/i.test(userAgent)) device = 'Tablet';
    else if (/bot|crawler|spider/i.test(userAgent)) device = 'Bot';
    let location = { city: 'Unknown', country: 'Unknown' };
    try {
        const geoRes = await axios.get(`http://ip-api.com/json/${ip}`, { timeout: 3000 });
        if (geoRes.data && geoRes.data.status === 'success') {
            location = { city: geoRes.data.city, country: geoRes.data.countryCode };
        }
    } catch (err) { /* ignore */ }
    return { ip, device, location, userAgent };
}

// ========== DEFAULT DATA ==========
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

// ========== ACTIVE SESSIONS ==========
const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sid, data] of activeSessions.entries()) {
        if (now - data.lastSeen > 60000) activeSessions.delete(sid);
    }
}, 30000);

let cacheVersion = Date.now();

// ========== PAYMENT STORAGE (in‑memory) ==========
const pendingPayments = new Map();
const verifiedPayments = new Map();
const downloadTokens = new Map();

// ========== ADMIN AUTH ==========
const ADMIN_PASSWORD_HASH = '0726019859';
const RECOVERY_EMAIL = 'victorngetich388@gmail.com';
let resetCodes = {};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || RECOVERY_EMAIL,
        pass: process.env.EMAIL_PASS,
    },
});

// ========== PAYNECTA CONFIG ==========
const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE;

// ========== MULTER ERROR HANDLER ==========
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') return res.status(413).json({ error: 'File too large (max 50MB)' });
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

// ========== ADMIN AUTH ENDPOINTS ==========
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD_HASH) {
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
        return res.status(400).json({ error: 'Invalid or expired code' });
    }
    delete resetCodes[code];
    res.json({ success: true, message: 'Password reset. Update your environment variable manually.' });
});

app.post('/api/admin/change-password', isAdmin, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== ADMIN_PASSWORD_HASH) return res.status(401).json({ error: 'Current password incorrect' });
    res.json({ success: true, message: 'Change requested. Update Render environment variable.' });
});

app.get('/api/cache-version', (req, res) => { res.json({ version: cacheVersion }); });
app.post('/api/admin/clear-cache', isAdmin, (req, res) => { cacheVersion = Date.now(); res.json({ success: true }); });

// ========== ACTIVE USERS ==========
app.post('/api/heartbeat', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    activeSessions.set(sessionId, { ip: getClientIp(req), lastSeen: Date.now(), firstSeen: activeSessions.has(sessionId) ? activeSessions.get(sessionId).firstSeen : Date.now() });
    res.json({ success: true, activeCount: activeSessions.size });
});

app.get('/api/admin/active-users', isAdmin, (req, res) => {
    const now = Date.now();
    const activeList = [];
    for (const [sid, data] of activeSessions.entries()) {
        if (now - data.lastSeen <= 60000) {
            activeList.push({ sessionId: sid.substring(0,8), ip: data.ip, lastSeen: data.lastSeen });
        }
    }
    res.json({ activeCount: activeList.length, activeUsers: activeList });
});

app.post('/api/leave', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) activeSessions.delete(sessionId);
    res.json({ success: true });
});

// ========== LEARNING AREAS ==========
app.get('/api/admin/learning-areas', isAdmin, (req, res) => {
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    if (areas.length === 0) areas = defaultLearningAreas;
    res.json(areas);
});
app.get('/api/learning-areas', (req, res) => {
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    if (areas.length === 0) areas = defaultLearningAreas;
    res.json(areas.filter(a => a.active === true));
});
app.post('/api/admin/learning-areas', isAdmin, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    const newId = areas.length ? Math.max(...areas.map(a => a.id)) + 1 : 1;
    const newArea = { id: newId, name, active: true, order: areas.length + 1 };
    areas.push(newArea);
    writeJSON(LEARNING_AREAS_FILE, areas);
    cacheVersion = Date.now();
    res.json({ success: true, area: newArea });
});
app.put('/api/admin/learning-areas/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { name, active, order } = req.body;
    let areas = readJSON(LEARNING_AREAS_FILE, []);
    const index = areas.findIndex(a => a.id === id);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    if (name !== undefined) areas[index].name = name;
    if (active !== undefined) areas[index].active = active;
    if (order !== undefined) areas[index].order = order;
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

// ========== GRADES ==========
app.get('/api/admin/grades', isAdmin, (req, res) => {
    let grades = readJSON(GRADES_FILE, []);
    if (grades.length === 0) grades = defaultGrades;
    res.json(grades);
});
app.get('/api/grades', (req, res) => {
    let grades = readJSON(GRADES_FILE, []);
    if (grades.length === 0) grades = defaultGrades;
    res.json(grades.filter(g => g.active === true));
});
app.post('/api/admin/grades', isAdmin, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let grades = readJSON(GRADES_FILE, []);
    const newId = grades.length ? Math.max(...grades.map(g => g.id)) + 1 : 1;
    const newGrade = { id: newId, name, active: true, order: grades.length + 1 };
    grades.push(newGrade);
    writeJSON(GRADES_FILE, grades);
    cacheVersion = Date.now();
    res.json({ success: true, grade: newGrade });
});
app.delete('/api/admin/grades/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let grades = readJSON(GRADES_FILE, []);
    grades = grades.filter(g => g.id !== id);
    writeJSON(GRADES_FILE, grades);
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ========== TERM SETTINGS ==========
app.get('/api/admin/term-settings', isAdmin, (req, res) => {
    res.json(readJSON(TERM_SETTINGS_FILE, { term1: true, term2: true, term3: true }));
});
app.put('/api/admin/term-settings', isAdmin, (req, res) => {
    writeJSON(TERM_SETTINGS_FILE, req.body);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.get('/api/term-settings', (req, res) => {
    res.json(readJSON(TERM_SETTINGS_FILE, { term1: true, term2: true, term3: true }));
});

// ========== DEFAULT TERM SELECTION ==========
function getDefaultTerm() {
    if (!fs.existsSync(DEFAULT_TERM_FILE)) return 1;
    const data = JSON.parse(fs.readFileSync(DEFAULT_TERM_FILE));
    return data.defaultTerm || 1;
}
function setDefaultTerm(term) {
    fs.writeFileSync(DEFAULT_TERM_FILE, JSON.stringify({ defaultTerm: term }));
}
app.get('/api/admin/default-term', isAdmin, (req, res) => {
    res.json({ defaultTerm: getDefaultTerm() });
});
app.post('/api/admin/default-term', isAdmin, (req, res) => {
    const { defaultTerm } = req.body;
    if (![1,2,3].includes(defaultTerm)) return res.status(400).json({ error: 'Invalid term' });
    setDefaultTerm(defaultTerm);
    res.json({ success: true });
});
app.get('/api/default-term', (req, res) => {
    res.json({ defaultTerm: getDefaultTerm() });
});

// ========== PRODUCT MANAGEMENT ==========
app.get('/api/admin/products', isAdmin, (req, res) => {
    res.json(readJSON(PRODUCTS_FILE, []));
});
app.get('/api/products', (req, res) => {
    const products = readJSON(PRODUCTS_FILE, []);
    const now = new Date();
    const visibleProducts = products.filter(p => {
        if (p.visible === false) return false;
        if (p.visibleStart && new Date(p.visibleStart) > now) return false;
        if (p.visibleEnd && new Date(p.visibleEnd) < now) return false;
        return true;
    });
    res.json(visibleProducts);
});

app.post('/api/admin/products', isAdmin, upload.fields([{ name: 'pdfFile', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]), (req, res) => {
    try {
        const { title, grade, term, subject, price, pages, weeks, visible, visibleStart, visibleEnd } = req.body;
        if (!title || !grade || !term || !subject || !price) return res.status(400).json({ error: 'All fields required' });
        const pdfFile = req.files?.['pdfFile']?.[0];
        if (!pdfFile) return res.status(400).json({ error: 'File required' });
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${pdfFile.filename}`;
        const coverFile = req.files?.['coverImage']?.[0];
        const coverUrl = coverFile ? `${req.protocol}://${req.get('host')}/covers/${coverFile.filename}` : null;
        const products = readJSON(PRODUCTS_FILE, []);
        const newId = products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;
        const newProduct = {
            id: newId, title, grade, term: parseInt(term), subject,
            price: parseInt(price), pages: pages ? parseInt(pages) : null,
            weeks: weeks ? parseInt(weeks) : 12,
            fileUrl, coverUrl, visible: visible === 'true' || visible === true,
            visibleStart: visibleStart || null,
            visibleEnd: visibleEnd || null,
            createdAt: new Date().toISOString(),
        };
        products.push(newProduct);
        writeJSON(PRODUCTS_FILE, products);
        cacheVersion = Date.now();
        res.json({ success: true, product: newProduct });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Upload failed: ' + err.message });
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

// ========== BACKUP & RESTORE ==========
app.get('/api/admin/backup', isAdmin, (req, res) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment('schemevault-backup.zip');
    archive.pipe(res);
    const jsonFiles = [PRODUCTS_FILE, STATS_AGGREGATED_FILE, VISIT_LOGS_FILE, DOWNLOAD_LOGS_FILE, PAYMENT_LOGS_FILE, MESSAGES_FILE, ACTIVITY_FILE, CLIENTS_FILE, FEEDBACK_FILE, TERM_SETTINGS_FILE, DEFAULT_TERM_FILE, BANNER_FILE, WHATSAPP_FILE, POPUPS_FILE, LEARNING_AREAS_FILE, GRADES_FILE];
    jsonFiles.forEach(file => { if (fs.existsSync(file)) archive.file(file, { name: `data/${path.basename(file)}` }); });
    if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');
    if (fs.existsSync(COVERS_DIR)) archive.directory(COVERS_DIR, 'covers');
    archive.finalize();
});

app.post('/api/admin/restore', isAdmin, upload.single('backupFile'), async (req, res) => {
    const zipFile = req.file;
    if (!zipFile) return res.status(400).json({ error: 'No file uploaded' });
    const extractPath = path.join(DATA_DIR, 'restore_temp');
    if (!fs.existsSync(extractPath)) fs.mkdirSync(extractPath);
    try {
        await extract(zipFile.path, { dir: extractPath });
        const dataDir = path.join(extractPath, 'data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            for (const file of files) {
                fs.copyFileSync(path.join(dataDir, file), path.join(DATA_DIR, file));
            }
        }
        const uploadsBackup = path.join(extractPath, 'uploads');
        if (fs.existsSync(uploadsBackup)) {
            const files = fs.readdirSync(uploadsBackup);
            for (const file of files) {
                fs.copyFileSync(path.join(uploadsBackup, file), path.join(UPLOAD_DIR, file));
            }
        }
        const coversBackup = path.join(extractPath, 'covers');
        if (fs.existsSync(coversBackup)) {
            const files = fs.readdirSync(coversBackup);
            for (const file of files) {
                fs.copyFileSync(path.join(coversBackup, file), path.join(COVERS_DIR, file));
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

// ========== ANALYTICS & LOGGING ==========
app.post('/api/track-visit', async (req, res) => {
    const { sessionId } = req.body;
    const info = await getClientInfo(req);
    const logs = readJSON(VISIT_LOGS_FILE, []);
    logs.push({
        timestamp: new Date().toISOString(),
        ip: info.ip,
        device: info.device,
        city: info.location.city,
        country: info.location.country,
        sessionId: sessionId || null
    });
    writeJSON(VISIT_LOGS_FILE, logs);
    updateAggregatedStats('visit');
    res.json({ success: true });
});

app.post('/api/track-download', async (req, res) => {
    const { productId, productName, price } = req.body;
    const info = await getClientInfo(req);
    const logs = readJSON(DOWNLOAD_LOGS_FILE, []);
    logs.push({
        timestamp: new Date().toISOString(),
        ip: info.ip,
        device: info.device,
        city: info.location.city,
        country: info.location.country,
        productId, productName, price
    });
    writeJSON(DOWNLOAD_LOGS_FILE, logs);
    updateAggregatedStats('download');
    res.json({ success: true });
});

app.post('/api/track-payment', async (req, res) => {
    const { transactionId, amount, productId } = req.body;
    const info = await getClientInfo(req);
    const logs = readJSON(PAYMENT_LOGS_FILE, []);
    logs.push({
        timestamp: new Date().toISOString(),
        ip: info.ip,
        device: info.device,
        city: info.location.city,
        country: info.location.country,
        transactionId, amount, productId
    });
    writeJSON(PAYMENT_LOGS_FILE, logs);
    updateAggregatedStats('payment');
    res.json({ success: true });
});

app.get('/api/admin/analytics', isAdmin, (req, res) => {
    const aggregated = getAggregatedStats();
    const visits = readJSON(VISIT_LOGS_FILE, []);
    const downloads = readJSON(DOWNLOAD_LOGS_FILE, []);
    const payments = readJSON(PAYMENT_LOGS_FILE, []);
    res.json({
        aggregated,
        recentVisits: visits.slice(-100),
        recentDownloads: downloads.slice(-50),
        recentPayments: payments.slice(-50),
        totalLogs: {
            visits: visits.length,
            downloads: downloads.length,
            payments: payments.length
        }
    });
});

app.post('/api/admin/clear-logs', isAdmin, (req, res) => {
    const { type, olderThan } = req.body;
    let cutoff = null;
    if (olderThan === 'month') cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    else if (olderThan === 'year') cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const filterOld = (logs) => {
        if (!cutoff) return [];
        return logs.filter(log => new Date(log.timestamp) >= cutoff);
    };
    if (type === 'visits' || type === 'all') {
        let logs = readJSON(VISIT_LOGS_FILE, []);
        logs = cutoff ? filterOld(logs) : [];
        writeJSON(VISIT_LOGS_FILE, logs);
    }
    if (type === 'downloads' || type === 'all') {
        let logs = readJSON(DOWNLOAD_LOGS_FILE, []);
        logs = cutoff ? filterOld(logs) : [];
        writeJSON(DOWNLOAD_LOGS_FILE, logs);
    }
    if (type === 'payments' || type === 'all') {
        let logs = readJSON(PAYMENT_LOGS_FILE, []);
        logs = cutoff ? filterOld(logs) : [];
        writeJSON(PAYMENT_LOGS_FILE, logs);
    }
    res.json({ success: true });
});

// ========== FEEDBACK / INBOX ==========
app.get('/api/admin/feedback', isAdmin, (req, res) => { res.json(readJSON(FEEDBACK_FILE, [])); });
app.post('/api/submit-feedback', async (req, res) => {
    const { message, whatsapp, email, name } = req.body;
    const info = await getClientInfo(req);
    const feedback = readJSON(FEEDBACK_FILE, []);
    feedback.push({
        id: Date.now(),
        name: name || 'Anonymous',
        email: email || null,
        whatsapp: whatsapp || null,
        message,
        ip: info.ip,
        device: info.device,
        location: `${info.location.city}, ${info.location.country}`,
        timestamp: new Date().toISOString(),
        read: false,
        replied: false
    });
    writeJSON(FEEDBACK_FILE, feedback);
    res.json({ success: true });
});
app.put('/api/admin/feedback/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { read, replied, replyMessage } = req.body;
    let feedback = readJSON(FEEDBACK_FILE, []);
    const idx = feedback.findIndex(f => f.id === id);
    if (idx !== -1) {
        if (read !== undefined) feedback[idx].read = read;
        if (replied !== undefined) feedback[idx].replied = replied;
        if (replyMessage) feedback[idx].reply = replyMessage;
        writeJSON(FEEDBACK_FILE, feedback);
    }
    res.json({ success: true });
});

// ========== BANNER ==========
app.get('/api/banner', (req, res) => { res.json(readJSON(BANNER_FILE, { enabled: false, text: '', startDate: null, endDate: null })); });
app.get('/api/admin/banner', isAdmin, (req, res) => { res.json(readJSON(BANNER_FILE, { enabled: false, text: '', startDate: null, endDate: null })); });
app.post('/api/admin/banner', isAdmin, (req, res) => {
    const { enabled, text, startDate, endDate } = req.body;
    writeJSON(BANNER_FILE, { enabled, text, startDate: startDate || null, endDate: endDate || null });
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ========== WHATSAPP BUTTON ==========
app.get('/api/admin/whatsapp', isAdmin, (req, res) => { res.json(readJSON(WHATSAPP_FILE, { enabled: false, phone: '', message: '' })); });
app.post('/api/admin/whatsapp', isAdmin, (req, res) => {
    const { enabled, phone, message } = req.body;
    writeJSON(WHATSAPP_FILE, { enabled, phone, message });
    cacheVersion = Date.now();
    res.json({ success: true });
});

// ========== POPUPS ==========
app.get('/api/admin/popups', isAdmin, (req, res) => { res.json(readJSON(POPUPS_FILE, [])); });
app.post('/api/admin/popups', isAdmin, (req, res) => {
    const { question, options, triggerType, delaySeconds, whatsappCollect } = req.body;
    const popups = readJSON(POPUPS_FILE, []);
    popups.push({
        id: Date.now(),
        question,
        options: options || [],
        triggerType: triggerType || 'onload',
        delaySeconds: delaySeconds || 0,
        whatsappCollect: whatsappCollect || false,
        active: true,
        startDate: new Date().toISOString(),
        endDate: null,
        createdAt: new Date().toISOString()
    });
    writeJSON(POPUPS_FILE, popups);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.delete('/api/admin/popups/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let popups = readJSON(POPUPS_FILE, []);
    popups = popups.filter(p => p.id !== id);
    writeJSON(POPUPS_FILE, popups);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.get('/api/popups', (req, res) => {
    const popups = readJSON(POPUPS_FILE, []);
    const now = new Date();
    res.json(popups.filter(p => p.active && new Date(p.startDate) <= now && (!p.endDate || new Date(p.endDate) >= now)));
});

// ========== MESSAGES ==========
app.get('/api/admin/messages', isAdmin, (req, res) => { res.json(readJSON(MESSAGES_FILE, [])); });
app.post('/api/admin/messages', isAdmin, (req, res) => {
    const { title, content, type, startDate, endDate, isActive } = req.body;
    const messages = readJSON(MESSAGES_FILE, []);
    messages.push({
        id: Date.now(),
        title, content,
        type: type || 'banner',
        startDate: new Date(startDate).toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : null,
        active: isActive === true || isActive === 'true',
        createdAt: new Date().toISOString()
    });
    writeJSON(MESSAGES_FILE, messages);
    cacheVersion = Date.now();
    res.json({ success: true });
});
app.put('/api/admin/messages/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const { active } = req.body;
    let messages = readJSON(MESSAGES_FILE, []);
    const idx = messages.findIndex(m => m.id === id);
    if (idx !== -1) { messages[idx].active = active; writeJSON(MESSAGES_FILE, messages); cacheVersion = Date.now(); }
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

// ========== PAYMENT ENDPOINTS (FIXED WITH DETAILED LOGGING) ==========
async function queryPaynectaStatus(transactionReference) {
    if (!PAYNECTA_API_KEY || !PAYNECTA_EMAIL) {
        console.log('⚠️ Paynecta credentials missing, cannot query status');
        return null;
    }
    try {
        const url = `${PAYNECTA_API_URL}/payment/status?transaction_reference=${encodeURIComponent(transactionReference)}`;
        console.log(`📡 Querying Paynecta: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'X-API-Key': PAYNECTA_API_KEY,
                'X-User-Email': PAYNECTA_EMAIL
            },
            timeout: 10000
        });
        console.log(`📡 Paynecta response:`, JSON.stringify(response.data, null, 2));
        if (response.data?.success && response.data?.data) {
            return response.data.data;
        }
        return null;
    } catch (err) {
        console.error(`❌ Status query error:`, err.response?.status, err.response?.data || err.message);
        return null;
    }
}

app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, productId } = req.body;
    if (!phone || !amount || !productId) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    
    let cleanPhone = phone.replace(/\s/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.substring(1);
    else if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
    
    const transactionId = 'TXN_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === parseInt(productId));
    if (!product) return res.status(400).json({ success: false, error: 'Product not found' });
    
    pendingPayments.set(transactionId, {
        productId: parseInt(productId), productTitle: product.title, productGrade: product.grade,
        productTerm: product.term, fileUrl: product.fileUrl, amount: parseInt(amount),
        phone: cleanPhone, status: 'pending', timestamp: Date.now(), paynectaRef: null
    });
    
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    if (!stats.payments) stats.payments = [];
    stats.payments.push({
        date: new Date().toISOString(),
        status: 'pending',
        amount: parseInt(amount),
        phone: cleanPhone,
        productId: parseInt(productId),
        transactionId
    });
    writeJSON(STATS_FILE, stats);
    
    // Demo mode if credentials missing
    if (!PAYNECTA_API_KEY || !PAYNECTA_EMAIL || !PAYNECTA_PAYMENT_CODE) {
        console.log('🎮 Demo mode: auto-confirming payment in 5 seconds');
        setTimeout(() => {
            const payment = pendingPayments.get(transactionId);
            if (payment && payment.status === 'pending') {
                payment.status = 'success';
                const verifyToken = 'DEMO_' + Date.now() + '_' + transactionId;
                verifiedPayments.set(verifyToken, {
                    productId: payment.productId, productTitle: payment.productTitle,
                    productGrade: payment.productGrade, productTerm: payment.productTerm,
                    fileUrl: payment.fileUrl, transactionId, amount: payment.amount,
                    expires: Date.now() + 300000
                });
                console.log(`✅ Demo payment confirmed for ${transactionId}`);
            }
        }, 5000);
        return res.json({ success: true, transactionId, demoMode: true });
    }
    
    // Real Paynecta
    try {
        const initUrl = `${PAYNECTA_API_URL}/payment/initialize`;
        console.log(`💳 Initiating STK Push to: ${initUrl}`);
        const response = await axios.post(initUrl, {
            code: PAYNECTA_PAYMENT_CODE,
            mobile_number: cleanPhone,
            amount: parseInt(amount)
        }, {
            headers: {
                'X-API-Key': PAYNECTA_API_KEY,
                'X-User-Email': PAYNECTA_EMAIL,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
        
        console.log(`💳 Paynecta init response:`, JSON.stringify(response.data, null, 2));
        
        if (response.data?.success === true) {
            const paynectaRef = response.data.data?.transaction_reference || 
                               response.data.data?.checkout_request_id ||
                               response.data.data?.reference ||
                               null;
            const payment = pendingPayments.get(transactionId);
            if (payment && paynectaRef) {
                payment.paynectaRef = paynectaRef;
                console.log(`✅ Stored Paynecta reference: ${paynectaRef}`);
            } else {
                console.log(`⚠️ No transaction_reference received from Paynecta. Will use transactionId as fallback.`);
            }
            res.json({ success: true, transactionId });
        } else {
            console.error(`❌ Paynecta init failed:`, response.data?.message);
            res.status(400).json({ success: false, error: response.data?.message || 'Payment initiation failed' });
        }
    } catch (error) {
        console.error(`❌ Paynecta request error:`, error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/payment-status/:transactionId', async (req, res) => {
    const { transactionId } = req.params;
    console.log(`🔍 Checking status for ${transactionId}`);
    
    const pending = pendingPayments.get(transactionId);
    if (!pending) {
        // Already verified?
        for (const [token, data] of verifiedPayments.entries()) {
            if (data.transactionId === transactionId && data.expires > Date.now()) {
                console.log(`✅ Found already verified payment for ${transactionId}`);
                return res.json({ status: 'success', verified: true, token });
            }
        }
        return res.json({ status: 'not_found', verified: false });
    }
    
    // Already marked success in memory?
    if (pending.status === 'success') {
        const verifyToken = 'VER_' + Date.now() + '_' + transactionId;
        verifiedPayments.set(verifyToken, { ...pending, transactionId, expires: Date.now() + 300000 });
        pendingPayments.delete(transactionId);
        console.log(`✅ Payment already success in memory for ${transactionId}`);
        return res.json({ status: 'success', verified: true, token: verifyToken });
    }
    
    // Query Paynecta
    const paynectaRef = pending.paynectaRef || transactionId;
    console.log(`📡 Querying Paynecta with reference: ${paynectaRef}`);
    const paynectaData = await queryPaynectaStatus(paynectaRef);
    
    if (paynectaData && paynectaData.status === 'completed' && paynectaData.result_code === 0) {
        console.log(`✅✅✅ PAYMENT CONFIRMED for ${transactionId}`);
        pending.status = 'success';
        const verifyToken = 'VER_' + Date.now() + '_' + transactionId;
        verifiedPayments.set(verifyToken, { ...pending, transactionId, expires: Date.now() + 300000 });
        pendingPayments.delete(transactionId);
        
        // Track payment
        fetch(`${req.protocol}://${req.get('host')}/api/track-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionId, amount: pending.amount, productId: pending.productId })
        }).catch(() => {});
        
        return res.json({ status: 'success', verified: true, token: verifyToken });
    } else if (paynectaData && (paynectaData.status === 'failed' || paynectaData.status === 'cancelled')) {
        console.log(`❌ Payment failed for ${transactionId}`);
        pending.status = 'failed';
        pendingPayments.delete(transactionId);
        return res.json({ status: 'failed', verified: false });
    }
    
    console.log(`⏳ Payment still pending for ${transactionId}`);
    return res.json({ status: 'pending', verified: false });
});

app.post('/api/request-download', (req, res) => {
    const { verificationToken, productId } = req.body;
    const verified = verifiedPayments.get(verificationToken);
    if (!verified || verified.expires < Date.now()) {
        return res.status(403).json({ error: 'Invalid or expired verification token' });
    }
    if (verified.productId !== parseInt(productId)) {
        return res.status(403).json({ error: 'Product mismatch' });
    }
    const downloadToken = Math.random().toString(36).substring(2, 20) + Date.now().toString(36);
    const fileExt = path.extname(verified.fileUrl).toLowerCase();
    let filename = `${verified.productTitle}_${verified.productGrade}_Term${verified.productTerm}`;
    if (fileExt === '.pdf') filename += '.pdf';
    else if (fileExt === '.doc') filename += '.doc';
    else if (fileExt === '.docx') filename += '.docx';
    else filename += '.pdf';
    
    downloadTokens.set(downloadToken, {
        productId: verified.productId,
        fileUrl: verified.fileUrl,
        filename: filename,
        expires: Date.now() + 120000
    });
    verifiedPayments.delete(verificationToken);
    res.json({ success: true, token: downloadToken });
});

app.get('/api/download/:token', async (req, res) => {
    const { token } = req.params;
    const record = downloadTokens.get(token);
    if (!record || record.expires < Date.now()) {
        return res.status(403).send('Download link expired or invalid.');
    }
    try {
        const fileExt = path.extname(record.filename).toLowerCase();
        let contentType = 'application/octet-stream';
        if (fileExt === '.pdf') contentType = 'application/pdf';
        else if (fileExt === '.doc') contentType = 'application/msword';
        else if (fileExt === '.docx') contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        
        res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
        res.setHeader('Content-Type', contentType);
        
        if (record.fileUrl.startsWith('http')) {
            const response = await axios({ method: 'GET', url: record.fileUrl, responseType: 'stream' });
            response.data.pipe(res);
        } else {
            const filePath = path.join(__dirname, record.fileUrl);
            if (fs.existsSync(filePath)) {
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.status(404).send('File not found');
            }
        }
        downloadTokens.delete(token);
    } catch (err) {
        console.error(err);
        res.status(500).send('Download error');
    }
});

app.post('/api/admin/force-confirm', isAdmin, (req, res) => {
    const { transactionId, productId } = req.body;
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === parseInt(productId));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const verifyToken = 'ADMIN_' + Date.now() + '_' + transactionId;
    verifiedPayments.set(verifyToken, {
        productId: product.id, productTitle: product.title, productGrade: product.grade,
        productTerm: product.term, fileUrl: product.fileUrl, transactionId, amount: product.price,
        expires: Date.now() + 300000
    });
    res.json({ success: true, token: verifyToken });
});

// ========== ADMIN STATS ==========
app.get('/api/admin/stats', isAdmin, (req, res) => {
    const aggregated = getAggregatedStats();
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
    const storageMB = ((getSize(UPLOAD_DIR) + getSize(COVERS_DIR)) / (1024 * 1024)).toFixed(2);
    res.json({ summary: aggregated, storageUsed: storageMB });
});

// ========== DEBUG ENDPOINT (temporary) ==========
app.get('/api/debug-pending', isAdmin, (req, res) => {
    const pending = Array.from(pendingPayments.entries()).map(([id, p]) => ({
        transactionId: id,
        paynectaRef: p.paynectaRef,
        status: p.status,
        productTitle: p.productTitle,
        amount: p.amount,
        timestamp: p.timestamp
    }));
    res.json({ pending });
});

// ========== HEALTH ==========
app.get('/ping', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Persistent data directory: ${DATA_DIR}`);
    console.log(`💳 Paynecta configured: ${PAYNECTA_API_KEY ? 'YES' : 'NO'}`);
});
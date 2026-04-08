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
// Environment Variables (Paynecta)
// ------------------------------
const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://api.paynecta.co.ke';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE;

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

// Payment storage - IMPORTANT: These need to persist between requests
const pendingPayments = new Map(); // transactionId -> { productId, amount, phone, status, timestamp }
const verifiedPayments = new Map(); // token -> { productId, transactionId, amount, expires, downloadToken? }
const downloadTokens = new Map();   // token -> { productId, fileUrl, filename, expires }

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
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    activeSessions.set(sessionId, { ip, lastSeen: Date.now(), firstSeen: activeSessions.has(sessionId) ? activeSessions.get(sessionId).firstSeen : Date.now() });
    res.json({ success: true, activeCount: activeSessions.size });
});

app.get('/api/admin/active-users', isAdmin, (req, res) => {
    const now = Date.now();
    let active = 0;
    const activeList = [];
    for (const [sessionId, data] of activeSessions.entries()) {
        if (now - data.lastSeen <= 60000) {
            active++;
            activeList.push({ sessionId: sessionId.substring(0, 8), ip: data.ip, lastSeen: data.lastSeen });
        }
    }
    res.json({ activeCount: active, activeUsers: activeList });
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

app.get('/api/products', (req, res) => {
    const products = readJSON(PRODUCTS_FILE, []);
    res.json(products.filter(p => p.visible !== false));
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
// BACKUP & RESTORE
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
        const dataDir = path.join(extractPath, 'data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            for (const file of files) {
                const src = path.join(dataDir, file);
                const dest = path.join(__dirname, file);
                fs.copyFileSync(src, dest);
            }
        }
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

// ========== FIXED PAYMENT ENDPOINTS ==========

// Initialize Payment - Send STK Push
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, productId } = req.body;
    
    console.log(`📱 Payment initiation: phone=${phone}, amount=${amount}, productId=${productId}`);
    
    if (!phone || !amount || !productId) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    
    // Format phone number to 254XXXXXXXXX
    let cleanPhone = phone.replace(/\s/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '254' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('+')) {
        cleanPhone = cleanPhone.substring(1);
    }
    
    // Generate unique transaction ID
    const transactionId = 'TXN_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    
    // Get product details for file URL
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === parseInt(productId));
    
    if (!product) {
        return res.status(400).json({ success: false, error: 'Product not found' });
    }
    
    // Store pending payment with product file info
    pendingPayments.set(transactionId, {
        productId: parseInt(productId),
        productTitle: product.title,
        productGrade: product.grade,
        productTerm: product.term,
        fileUrl: product.fileUrl,
        amount: parseInt(amount),
        phone: cleanPhone,
        status: 'pending',
        timestamp: Date.now()
    });
    
    // If Paynecta credentials missing, use demo mode (auto-confirm after 3 seconds for testing)
    if (!PAYNECTA_API_KEY || !PAYNECTA_EMAIL || !PAYNECTA_PAYMENT_CODE) {
        console.log('⚠️ Paynecta credentials missing. Using DEMO MODE - auto-confirm in 3 seconds');
        
        // Auto-confirm after 3 seconds (for testing)
        setTimeout(() => {
            const payment = pendingPayments.get(transactionId);
            if (payment && payment.status === 'pending') {
                console.log(`✅ DEMO MODE: Auto-confirming payment for ${transactionId}`);
                payment.status = 'success';
                
                // Generate verification token
                const verifyToken = 'DEMO_' + Date.now() + '_' + transactionId;
                verifiedPayments.set(verifyToken, {
                    productId: payment.productId,
                    productTitle: payment.productTitle,
                    productGrade: payment.productGrade,
                    productTerm: payment.productTerm,
                    fileUrl: payment.fileUrl,
                    transactionId: transactionId,
                    amount: payment.amount,
                    expires: Date.now() + 300000
                });
                
                // Record in stats
                const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
                if (!stats.payments) stats.payments = [];
                stats.payments.push({
                    date: new Date().toISOString(),
                    status: 'success',
                    amount: payment.amount,
                    phone: cleanPhone,
                    productId: payment.productId,
                    transactionId: transactionId
                });
                writeJSON(STATS_FILE, stats);
            }
        }, 3000);
        
        // Record pending payment in stats
        const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
        if (!stats.payments) stats.payments = [];
        stats.payments.push({
            date: new Date().toISOString(),
            status: 'pending',
            amount: parseInt(amount),
            phone: cleanPhone,
            productId: parseInt(productId),
            transactionId: transactionId
        });
        writeJSON(STATS_FILE, stats);
        
        return res.json({ success: true, transactionId, demoMode: true });
    }
    
    // Real Paynecta integration
    try {
        console.log(`💳 Initiating Paynecta payment for ${cleanPhone} - KES ${amount}`);
        
        const response = await axios.post(
            `${PAYNECTA_API_URL}/api/v1/payment/initialize`,
            {
                code: PAYNECTA_PAYMENT_CODE,
                mobile_number: cleanPhone,
                amount: parseInt(amount)
            },
            {
                headers: {
                    'X-API-Key': PAYNECTA_API_KEY,
                    'X-User-Email': PAYNECTA_EMAIL,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        
        console.log('Paynecta response:', JSON.stringify(response.data, null, 2));
        
        if (response.data && response.data.success === true) {
            const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
            if (!stats.payments) stats.payments = [];
            stats.payments.push({
                date: new Date().toISOString(),
                status: 'pending',
                amount: parseInt(amount),
                phone: cleanPhone,
                productId: parseInt(productId),
                transactionId: transactionId,
                paynectaRef: response.data.data?.reference || null
            });
            writeJSON(STATS_FILE, stats);
            
            res.json({ success: true, transactionId });
        } else {
            console.error('Paynecta error:', response.data);
            res.status(400).json({
                success: false,
                error: response.data?.message || 'Payment initiation failed'
            });
        }
    } catch (error) {
        console.error('Paynecta API error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Payment service error'
        });
    }
});

// Check payment status - FIXED to return file info for download
app.get('/api/payment-status/:transactionId', (req, res) => {
    const { transactionId } = req.params;
    
    console.log(`🔍 Checking payment status for: ${transactionId}`);
    
    // Check pending payments first
    const pending = pendingPayments.get(transactionId);
    
    if (pending && pending.status === 'success') {
        console.log(`✅ Payment successful for ${transactionId}, generating verification token`);
        
        // Generate verification token with file info
        const verifyToken = 'VER_' + Date.now() + '_' + transactionId;
        verifiedPayments.set(verifyToken, {
            productId: pending.productId,
            productTitle: pending.productTitle,
            productGrade: pending.productGrade,
            productTerm: pending.productTerm,
            fileUrl: pending.fileUrl,
            transactionId: transactionId,
            amount: pending.amount,
            expires: Date.now() + 300000  // 5 minutes
        });
        
        // Clean up pending payment
        pendingPayments.delete(transactionId);
        
        return res.json({ 
            status: 'success', 
            verified: true, 
            token: verifyToken,
            productInfo: {
                title: pending.productTitle,
                grade: pending.productGrade,
                term: pending.productTerm
            }
        });
    }
    
    if (pending && pending.status === 'failed') {
        pendingPayments.delete(transactionId);
        return res.json({ status: 'failed', verified: false });
    }
    
    if (pending) {
        return res.json({ status: 'pending', verified: false });
    }
    
    // Check if already verified (for webhook-triggered payments)
    for (const [token, data] of verifiedPayments.entries()) {
        if (data.transactionId === transactionId && data.expires > Date.now()) {
            console.log(`✅ Found existing verified payment for ${transactionId}`);
            return res.json({ 
                status: 'success', 
                verified: true, 
                token: token,
                productInfo: {
                    title: data.productTitle,
                    grade: data.productGrade,
                    term: data.productTerm
                }
            });
        }
    }
    
    return res.json({ status: 'not_found', verified: false });
});

// Paynecta Webhook - Called when payment completes
app.post('/api/payment-webhook', async (req, res) => {
    console.log('📞 Webhook received:', JSON.stringify(req.body, null, 2));
    
    // Paynecta webhook format - adjust based on actual Paynecta response
    const { reference, transactionId, ResultCode, resultCode, status, data } = req.body;
    
    // Extract the reference/transaction ID
    let txnId = reference || transactionId || data?.reference || data?.transactionId;
    
    // Check if payment was successful
    const isSuccess = (ResultCode === 0 || resultCode === 0 || status === 'success' || status === 'completed');
    
    if (txnId && isSuccess) {
        console.log(`✅ Webhook: Payment successful for ${txnId}`);
        
        // Find the pending payment
        let foundPayment = null;
        let foundTxnId = null;
        
        for (const [id, payment] of pendingPayments.entries()) {
            if (id === txnId || id.endsWith(txnId) || txnId.endsWith(id)) {
                foundTxnId = id;
                foundPayment = payment;
                break;
            }
        }
        
        if (foundPayment) {
            foundPayment.status = 'success';
            console.log(`✅ Updated pending payment status for ${foundTxnId}`);
            
            // Generate verification token
            const verifyToken = 'WEB_' + Date.now() + '_' + foundTxnId;
            verifiedPayments.set(verifyToken, {
                productId: foundPayment.productId,
                productTitle: foundPayment.productTitle,
                productGrade: foundPayment.productGrade,
                productTerm: foundPayment.productTerm,
                fileUrl: foundPayment.fileUrl,
                transactionId: foundTxnId,
                amount: foundPayment.amount,
                expires: Date.now() + 300000
            });
        } else {
            // Update stats file
            const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
            const payment = stats.payments.find(p => p.transactionId === txnId || p.transactionId?.endsWith(txnId));
            if (payment && payment.status !== 'success') {
                payment.status = 'success';
                writeJSON(STATS_FILE, stats);
                console.log(`✅ Updated payment in stats for ${txnId}`);
            }
        }
    }
    
    res.sendStatus(200);
});

// Request download token - FIXED to use stored file URL
app.post('/api/request-download', (req, res) => {
    const { verificationToken, productId } = req.body;
    
    console.log(`📥 Download request: token=${verificationToken}, productId=${productId}`);
    
    if (!verificationToken || !productId) {
        return res.status(400).json({ error: 'Missing data' });
    }
    
    const verifiedData = verifiedPayments.get(verificationToken);
    if (!verifiedData) {
        console.log(`❌ Verification token not found: ${verificationToken}`);
        return res.status(403).json({ error: 'Invalid verification token' });
    }
    
    if (verifiedData.expires < Date.now()) {
        console.log(`❌ Verification token expired: ${verificationToken}`);
        verifiedPayments.delete(verificationToken);
        return res.status(403).json({ error: 'Verification token expired' });
    }
    
    if (verifiedData.productId !== parseInt(productId)) {
        console.log(`❌ Product ID mismatch: expected ${verifiedData.productId}, got ${productId}`);
        return res.status(403).json({ error: 'Product ID mismatch' });
    }
    
    // Get fresh product data to ensure file URL is valid
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === parseInt(productId));
    
    if (!product || !product.fileUrl) {
        console.log(`❌ Product not found or missing file URL: ${productId}`);
        return res.status(404).json({ error: 'Product file not found' });
    }
    
    // Generate download token (valid for 2 minutes)
    const downloadToken = Math.random().toString(36).substring(2, 20) + Date.now().toString(36);
    downloadTokens.set(downloadToken, {
        productId: parseInt(productId),
        fileUrl: product.fileUrl,
        filename: `${product.title.replace(/ /g, '_')}_${product.grade}_Term${product.term}.pdf`,
        expires: Date.now() + 120000  // 2 minutes
    });
    
    // Clean up used verification token
    verifiedPayments.delete(verificationToken);
    
    console.log(`✅ Download token generated: ${downloadToken} for product ${product.title}`);
    
    res.json({ success: true, token: downloadToken });
});

// Download PDF - FIXED to handle both local and remote files
app.get('/api/download/:token', async (req, res) => {
    const { token } = req.params;
    
    console.log(`📥 Download request for token: ${token}`);
    
    const record = downloadTokens.get(token);
    if (!record) {
        console.log(`❌ Download token not found: ${token}`);
        return res.status(403).send('Download link invalid. Please contact support.');
    }
    
    if (record.expires < Date.now()) {
        console.log(`❌ Download token expired: ${token}`);
        downloadTokens.delete(token);
        return res.status(403).send('Download link expired. Please contact support.');
    }
    
    console.log(`📄 Downloading file: ${record.filename} from ${record.fileUrl}`);
    
    try {
        // Set headers for PDF download
        res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
        res.setHeader('Content-Type', 'application/pdf');
        
        // Handle file URL (could be local path or remote URL)
        if (record.fileUrl.startsWith('http')) {
            // Remote file (from Render or external)
            const response = await axios({
                method: 'GET',
                url: record.fileUrl,
                responseType: 'stream'
            });
            response.data.pipe(res);
        } else {
            // Local file
            const filePath = path.join(__dirname, record.fileUrl);
            if (fs.existsSync(filePath)) {
                fs.createReadStream(filePath).pipe(res);
            } else {
                console.log(`❌ Local file not found: ${filePath}`);
                res.status(404).send('File not found on server');
            }
        }
        
        // Record download in stats
        const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
        stats.downloads.push({
            date: new Date().toISOString(),
            productId: record.productId,
            productName: record.filename,
            ip: getClientIp(req)
        });
        writeJSON(STATS_FILE, stats);
        
        // Clean up used download token
        downloadTokens.delete(token);
        
        console.log(`✅ Download successful for ${record.filename}`);
        
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).send('Download error. Please contact support.');
    }
});

// Admin force confirm payment (for testing/backup)
app.post('/api/admin/force-confirm', isAdmin, (req, res) => {
    const { transactionId, productId } = req.body;
    
    const products = readJSON(PRODUCTS_FILE, []);
    const product = products.find(p => p.id === parseInt(productId));
    
    if (!product) {
        return res.status(404).json({ error: 'Product not found' });
    }
    
    const verifyToken = 'ADMIN_' + Date.now() + '_' + transactionId;
    verifiedPayments.set(verifyToken, {
        productId: parseInt(productId),
        productTitle: product.title,
        productGrade: product.grade,
        productTerm: product.term,
        fileUrl: product.fileUrl,
        transactionId: transactionId,
        amount: product.price,
        expires: Date.now() + 300000
    });
    
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const payment = stats.payments.find(p => p.transactionId === transactionId);
    if (payment) payment.status = 'success';
    writeJSON(STATS_FILE, stats);
    
    res.json({ success: true, token: verifyToken });
});

// ------------------------------
// Public Endpoints
// ------------------------------
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
// Admin Analytics
// ------------------------------
app.get('/api/admin/stats', isAdmin, (req, res) => {
    const stats = readJSON(STATS_FILE, { visits: [], downloads: [], payments: [] });
    const storage = getStorageUsage();
    res.json({
        summary: {
            totalVisits: stats.visits.length,
            totalDownloads: stats.downloads.length,
            successfulPayments: stats.payments?.filter(p => p.status === 'success').length || 0,
            pendingPayments: stats.payments?.filter(p => p.status === 'pending').length || 0,
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
// Messages & Popups
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
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📦 Paynecta configured: ${PAYNECTA_API_KEY ? 'YES' : 'NO'}`);
    console.log(`💳 Payment Code: ${PAYNECTA_PAYMENT_CODE || 'NOT SET'}`);
});
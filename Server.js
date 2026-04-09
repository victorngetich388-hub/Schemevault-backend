const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const useragent = require('express-useragent');

const app = express();
app.use(cors());
app.use(useragent.express());
app.use(express.json());

// Persistent Storage Directories
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
[DATA_DIR, UPLOAD_DIR, COVERS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

const DB = {
    prods: path.join(DATA_DIR, 'products.json'),
    conf: path.join(DATA_DIR, 'config.json'),
    logs: path.join(DATA_DIR, 'logs.json')
};

const read = (f, d = []) => { try { return JSON.parse(fs.readFileSync(f)); } catch { return d; } };
const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// Initialize System Config
if (!fs.existsSync(DB.conf)) {
    save(DB.conf, { password: '0726019859', ticker: 'Welcome to SchemeVault!', tickerActive: false });
}

// Email Transporter (Gmail)
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// File Upload Logic
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'pdfFile' ? UPLOAD_DIR : COVERS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
});
const upload = multer({ storage });

let tempCodes = new Map();

// --- VISITOR TRACKING ---
app.post('/api/track', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    let loc = "Unknown Location";
    try {
        const g = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,country`);
        if(g.data.status === 'success') loc = `${g.data.city}, ${g.data.country}`;
    } catch(e) {}
    
    const logs = read(DB.logs);
    logs.unshift({
        ip, loc,
        device: `${req.useragent.platform} | ${req.useragent.browser}`,
        time: new Date().toLocaleString()
    });
    save(DB.logs, logs.slice(0, 1000));
    res.sendStatus(200);
});

// --- ADMIN API ---
app.post('/api/admin/login', (req, res) => {
    const conf = read(DB.conf, {});
    if(req.body.password === conf.password) res.json({ success: true, token: 'ADM_' + Date.now() });
    else res.status(401).json({ success: false });
});

app.post('/api/admin/request-code', async (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000);
    tempCodes.set('change', code);
    try {
        await mailer.sendMail({
            from: process.env.EMAIL_USER,
            to: 'victorngetich388@gmail.com',
            subject: 'SchemeVault Security Code',
            text: `Your change code is: ${code}. If you did not request this, ignore.`
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Mail failed' }); }
});

app.post('/api/admin/update-password', (req, res) => {
    if(req.body.code == tempCodes.get('change')) {
        const conf = read(DB.conf, {});
        conf.password = req.body.newPassword;
        save(DB.conf, conf);
        tempCodes.delete('change');
        res.json({ success: true });
    } else res.status(400).json({ error: 'Invalid code' });
});

app.post('/api/admin/upload', upload.fields([{name:'pdfFile'}, {name:'coverImage'}]), (req, res) => {
    const prods = read(DB.prods);
    prods.push({
        id: Date.now(),
        title: req.body.title,
        grade: req.body.grade,
        price: parseInt(req.body.price),
        visible: req.body.visible === 'true',
        hideAt: req.body.hideAt || null,
        downloads: 0,
        pdf: `/uploads/${req.files.pdfFile[0].filename}`,
        cover: req.files.coverImage ? `/covers/${req.files.coverImage[0].filename}` : null
    });
    save(DB.prods, prods);
    res.json({ success: true });
});

app.get('/api/admin/data', (req, res) => {
    res.json({ logs: read(DB.logs), prods: read(DB.prods), conf: read(DB.conf, {}) });
});

app.post('/api/admin/ticker', (req, res) => {
    const conf = read(DB.conf, {});
    conf.ticker = req.body.text;
    conf.tickerActive = req.body.active;
    save(DB.conf, conf);
    res.json({ success: true });
});

app.delete('/api/admin/product/:id', (req, res) => {
    let prods = read(DB.prods);
    prods = prods.filter(p => p.id !== parseInt(req.params.id));
    save(DB.prods, prods);
    res.json({ success: true });
});

// --- CLIENT API ---
app.get('/api/client/init', (req, res) => {
    const conf = read(DB.conf, {});
    const prods = read(DB.prods).filter(p => {
        if (!p.visible) return false;
        if (p.hideAt && new Date(p.hideAt) < new Date()) return false;
        return true;
    });
    res.json({ prods, ticker: conf.tickerActive ? conf.ticker : null });
});

app.listen(3000, () => console.log('Server started on port 3000'));

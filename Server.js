const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Persistent storage
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

[DATA_DIR, UPLOAD_DIR, COVERS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

console.log(`📁 Using data dir: ${DATA_DIR}`);

// Multer for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'coverImage' ? COVERS_DIR : UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// JSON helpers
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const LEARNING_AREAS_FILE = path.join(DATA_DIR, 'learning_areas.json');
const GRADES_FILE = path.join(DATA_DIR, 'grades.json');
const TERM_SETTINGS_FILE = path.join(DATA_DIR, 'term_settings.json');

const readJSON = (file, defaultVal = []) => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultVal, null, 2));
    return defaultVal;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return defaultVal; }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// ADMIN PASSWORD (change in Render Environment Variables if needed)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0726019859';

// HEALTH CHECKS - This fixes the "Cannot GET /ping" issue
app.get('/ping', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ADMIN LOGIN - Fixed token handling
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = 'admin_' + Date.now() + '_' + Math.random().toString(36).substring(2);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

function isAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && token.startsWith('admin_')) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Learning Areas
app.get('/api/admin/learning-areas', isAdmin, (req, res) => res.json(readJSON(LEARNING_AREAS_FILE, [])));
app.get('/api/learning-areas', (req, res) => res.json(readJSON(LEARNING_AREAS_FILE, []).filter(a => a.active !== false)));

app.post('/api/admin/learning-areas', isAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  let areas = readJSON(LEARNING_AREAS_FILE, []);
  const newId = areas.length ? Math.max(...areas.map(a => a.id || 0)) + 1 : 1;
  areas.push({ id: newId, name, active: true });
  writeJSON(LEARNING_AREAS_FILE, areas);
  res.json({ success: true });
});

app.delete('/api/admin/learning-areas/:id', isAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  let areas = readJSON(LEARNING_AREAS_FILE, []);
  areas = areas.filter(a => a.id !== id);
  writeJSON(LEARNING_AREAS_FILE, areas);
  res.json({ success: true });
});

// Grades
app.get('/api/admin/grades', isAdmin, (req, res) => res.json(readJSON(GRADES_FILE, [])));
app.post('/api/admin/grades', isAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  let grades = readJSON(GRADES_FILE, []);
  const newId = grades.length ? Math.max(...grades.map(g => g.id || 0)) + 1 : 1;
  grades.push({ id: newId, name, active: true });
  writeJSON(GRADES_FILE, grades);
  res.json({ success: true });
});

app.delete('/api/admin/grades/:id', isAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  let grades = readJSON(GRADES_FILE, []);
  grades = grades.filter(g => g.id !== id);
  writeJSON(GRADES_FILE, grades);
  res.json({ success: true });
});

// Products (with cover + pages)
app.get('/api/admin/products', isAdmin, (req, res) => res.json(readJSON(PRODUCTS_FILE, [])));
app.get('/api/products', (req, res) => res.json(readJSON(PRODUCTS_FILE, []).filter(p => p.visible !== false)));

app.post('/api/admin/products', isAdmin, upload.fields([{name:'pdfFile', maxCount:1}, {name:'coverImage', maxCount:1}]), (req, res) => {
  try {
    const { title, grade, term, subject, price, pages, visible } = req.body;
    const pdfFile = req.files?.pdfFile?.[0];
    if (!title || !grade || !term || !subject || !price || !pdfFile) {
      return res.status(400).json({ error: 'Missing fields or PDF' });
    }
    const fileUrl = `/uploads/${pdfFile.filename}`;
    const coverFile = req.files?.coverImage?.[0];
    const coverUrl = coverFile ? `/covers/${coverFile.filename}` : null;

    const products = readJSON(PRODUCTS_FILE, []);
    const newId = products.length ? Math.max(...products.map(p => p.id || 0)) + 1 : 1;

    const newProduct = {
      id: newId, title, grade, term: parseInt(term), subject,
      price: parseInt(price), pages: pages ? parseInt(pages) : null,
      fileUrl, coverUrl, visible: visible === 'true' || visible === true,
      createdAt: new Date().toISOString()
    };

    products.push(newProduct);
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/products/:id', isAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  let products = readJSON(PRODUCTS_FILE, []);
  const index = products.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  products[index] = { ...products[index], ...req.body };
  writeJSON(PRODUCTS_FILE, products);
  res.json({ success: true });
});

app.delete('/api/admin/products/:id', isAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  let products = readJSON(PRODUCTS_FILE, []);
  const product = products.find(p => p.id === id);
  if (product) {
    if (product.fileUrl) {
      const fn = product.fileUrl.split('/').pop();
      fs.unlinkSync(path.join(UPLOAD_DIR, fn)).catch(() => {});
    }
    if (product.coverUrl) {
      const fn = product.coverUrl.split('/').pop();
      fs.unlinkSync(path.join(COVERS_DIR, fn)).catch(() => {});
    }
  }
  products = products.filter(p => p.id !== id);
  writeJSON(PRODUCTS_FILE, products);
  res.json({ success: true });
});

// Simple banner for running advert
app.get('/api/admin/banner', isAdmin, (req, res) => res.json({ enabled: true, text: 'Welcome to SchemeVault - Premium CBE Schemes' }));

// Basic payment demo (STK push simulation)
const pending = new Map();
const verified = new Map();

app.post('/api/initiate-payment', (req, res) => {
  const { phone, amount, productId } = req.body;
  const txId = 'TXN_' + Date.now();
  setTimeout(() => {
    const vToken = 'VER_' + Date.now();
    verified.set(vToken, { productId: parseInt(productId), expires: Date.now() + 300000 });
  }, 7000);
  res.json({ success: true, transactionId: txId });
});

app.get('/api/payment-status/:transactionId', (req, res) => {
  for (const [token, data] of verified) {
    if (data.expires > Date.now()) return res.json({ verified: true, token });
  }
  res.json({ verified: false });
});

app.post('/api/request-download', (req, res) => {
  const { verificationToken } = req.body;
  if (verified.has(verificationToken)) {
    res.json({ success: true, token: 'DL_' + Date.now() });
    verified.delete(verificationToken);
  } else res.status(403).json({ error: 'Invalid token' });
});

app.get('/api/download/:token', (req, res) => res.send('Download link active'));

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
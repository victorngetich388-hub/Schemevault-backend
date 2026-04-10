require('dotenv').config(); // Add this at top if you install dotenv

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

// ========== PERSISTENT STORAGE ==========
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

[DATA_DIR, UPLOAD_DIR, COVERS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/covers', express.static(COVERS_DIR));

console.log(`📁 Data directory: ${DATA_DIR}`);

// ========== MULTER ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'coverImage' ? COVERS_DIR : UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, '_');
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'pdfFile') {
      if (file.mimetype === 'application/pdf') return cb(null, true);
      return cb(new Error('Only PDF allowed'), false);
    }
    if (file.fieldname === 'coverImage') {
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
      return cb(new Error('Only images allowed'), false);
    }
    cb(null, true);
  }
});

// ========== JSON HELPERS ==========
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const LEARNING_AREAS_FILE = path.join(DATA_DIR, 'learning_areas.json');
const TERM_SETTINGS_FILE = path.join(DATA_DIR, 'term_settings.json');
const GRADES_FILE = path.join(DATA_DIR, 'grades.json');

const readJSON = (file, defaultVal = []) => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultVal, null, 2));
    return defaultVal;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${file}`, e);
    return defaultVal;
  }
};

const writeJSON = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error writing ${file}`, e);
  }
};

// ========== ADMIN AUTH (Simple) ==========
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0726019859';

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = Buffer.from(Date.now().toString() + Math.random()).toString('base64');
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

// ========== HEALTH & PING (Important for Render) ==========
app.get('/ping', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ========== LEARNING AREAS ==========
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

// ========== GRADES ==========
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

// ========== PRODUCTS ==========
app.get('/api/admin/products', isAdmin, (req, res) => res.json(readJSON(PRODUCTS_FILE, [])));
app.get('/api/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  res.json(products.filter(p => p.visible !== false));
});

app.post('/api/admin/products', isAdmin, upload.fields([{ name: 'pdfFile', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]), (req, res) => {
  try {
    const { title, grade, term, subject, price, pages, visible } = req.body;
    const pdfFile = req.files?.pdfFile?.[0];
    if (!title || !grade || !term || !subject || !price || !pdfFile) {
      return res.status(400).json({ error: 'Missing required fields or PDF' });
    }

    const fileUrl = `/uploads/${pdfFile.filename}`;
    const coverFile = req.files?.coverImage?.[0];
    const coverUrl = coverFile ? `/covers/${coverFile.filename}` : null;

    const products = readJSON(PRODUCTS_FILE, []);
    const newId = products.length ? Math.max(...products.map(p => p.id || 0)) + 1 : 1;

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
      createdAt: new Date().toISOString()
    };

    products.push(newProduct);
    writeJSON(PRODUCTS_FILE, products);
    res.json({ success: true, product: newProduct });
  } catch (err) {
    console.error(err);
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
  res.json({ success: true });
});

// ========== TERM SETTINGS (basic) ==========
app.get('/api/term-settings', (req, res) => res.json(readJSON(TERM_SETTINGS_FILE, { term1: true, term2: true, term3: true })));
app.get('/api/admin/term-settings', isAdmin, (req, res) => res.json(readJSON(TERM_SETTINGS_FILE, { term1: true, term2: true, term3: true })));

// ========== PAYMENT (demo mode for now) ==========
const pendingPayments = new Map();
const verifiedPayments = new Map();

app.post('/api/initiate-payment', (req, res) => {
  const { phone, amount, productId } = req.body;
  if (!phone || !amount || !productId) return res.status(400).json({ success: false, error: 'Missing fields' });

  const transactionId = 'TXN_' + Date.now();
  // Demo mode - auto confirm after 8 seconds
  setTimeout(() => {
    const verifyToken = 'VER_' + Date.now();
    verifiedPayments.set(verifyToken, { productId: parseInt(productId), expires: Date.now() + 300000 });
  }, 8000);

  res.json({ success: true, transactionId, demoMode: true });
});

app.get('/api/payment-status/:transactionId', (req, res) => {
  for (const [token, data] of verifiedPayments.entries()) {
    if (data.expires > Date.now()) return res.json({ verified: true, token });
  }
  res.json({ verified: false, status: 'pending' });
});

app.post('/api/request-download', (req, res) => {
  const { verificationToken, productId } = req.body;
  const verified = verifiedPayments.get(verificationToken);
  if (!verified || verified.expires < Date.now()) return res.status(403).json({ error: 'Invalid token' });

  const products = readJSON(PRODUCTS_FILE, []);
  const product = products.find(p => p.id === parseInt(productId));
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const downloadToken = 'DL_' + Date.now();
  res.json({ success: true, token: downloadToken });
});

app.get('/api/download/:token', (req, res) => {
  res.status(200).send('Download ready (use secure token in production)');
});

// ========== FINAL ==========
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Uploads: ${UPLOAD_DIR}`);
});
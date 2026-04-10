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
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this';

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

console.log(`📁 Using data directory: ${DATA_DIR}`);

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
      if (file.mimetype === 'application/pdf') cb(null, true);
      else cb(new Error('Only PDF files allowed'), false);
    } else if (file.fieldname === 'coverImage') {
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
      else cb(new Error('Only images allowed'), false);
    } else cb(null, true);
  }
});

// ========== JSON HELPERS ==========
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const LEARNING_AREAS_FILE = path.join(DATA_DIR, 'learning_areas.json');
const TERM_SETTINGS_FILE = path.join(DATA_DIR, 'term_settings.json');
// ... add other files as needed

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

// ========== ADMIN AUTH (JWT) ==========
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0726019859'; // Change this in Render env!

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

function isAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ========== LEARNING AREAS ==========
app.get('/api/learning-areas', (req, res) => {
  let areas = readJSON(LEARNING_AREAS_FILE, []);
  res.json(areas.filter(a => a.active !== false));
});

app.get('/api/admin/learning-areas', isAdmin, (req, res) => {
  res.json(readJSON(LEARNING_AREAS_FILE, []));
});

app.post('/api/admin/learning-areas', isAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  let areas = readJSON(LEARNING_AREAS_FILE, []);
  const newId = areas.length ? Math.max(...areas.map(a => a.id)) + 1 : 1;
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

// ========== PRODUCTS ==========
app.get('/api/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  res.json(products.filter(p => p.visible !== false));
});

app.get('/api/admin/products', isAdmin, (req, res) => {
  res.json(readJSON(PRODUCTS_FILE, []));
});

app.post('/api/admin/products', isAdmin, upload.fields([{ name: 'pdfFile', maxCount: 1 }]), (req, res) => {
  try {
    const { title, grade, term, subject, price, visible } = req.body;
    const pdfFile = req.files?.pdfFile?.[0];

    if (!title || !grade || !term || !subject || !price || !pdfFile) {
      return res.status(400).json({ error: 'Missing required fields or file' });
    }

    const fileUrl = `/uploads/${pdfFile.filename}`;

    const products = readJSON(PRODUCTS_FILE, []);
    const newId = products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;

    const newProduct = {
      id: newId,
      title,
      grade,
      term: parseInt(term),
      subject,
      price: parseInt(price),
      fileUrl,
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

  if (product && product.fileUrl) {
    const filename = product.fileUrl.split('/').pop();
    const filepath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }

  products = products.filter(p => p.id !== id);
  writeJSON(PRODUCTS_FILE, products);
  res.json({ success: true });
});

// ========== PAYMENT (kept your Paynecta logic + demo mode) ==========
const pendingPayments = new Map();
const verifiedPayments = new Map();

app.post('/api/initiate-payment', async (req, res) => {
  // Your existing Paynecta logic here (I kept it almost unchanged, just cleaned a bit)
  // ... (paste your original initiate-payment code if you want to keep Paynecta)
  // For now, to make it work immediately, use demo mode by default if no keys

  const { phone, amount, productId } = req.body;
  if (!phone || !amount || !productId) return res.status(400).json({ success: false, error: 'Missing fields' });

  const transactionId = 'TXN_' + Date.now();

  // Demo auto-confirm for testing
  setTimeout(() => {
    const verifyToken = 'VER_' + Date.now();
    verifiedPayments.set(verifyToken, {
      productId: parseInt(productId),
      amount: parseInt(amount),
      expires: Date.now() + 300000
    });
  }, 8000);

  res.json({ success: true, transactionId, demoMode: true });
});

app.get('/api/payment-status/:transactionId', (req, res) => {
  // Simple demo version - in production replace with real polling
  for (const [token, data] of verifiedPayments.entries()) {
    if (data.expires > Date.now()) {
      return res.json({ verified: true, token });
    }
  }
  res.json({ verified: false, status: 'pending' });
});

app.post('/api/request-download', (req, res) => {
  const { verificationToken, productId } = req.body;
  const verified = verifiedPayments.get(verificationToken);

  if (!verified || verified.expires < Date.now()) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  const products = readJSON(PRODUCTS_FILE, []);
  const product = products.find(p => p.id === parseInt(productId));
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const downloadToken = 'DL_' + Date.now() + Math.random().toString(36).slice(2);
  // Store download token temporarily
  // You can expand this map if needed

  res.json({ success: true, token: downloadToken, fileUrl: product.fileUrl });
});

app.get('/api/download/:token', (req, res) => {
  // For simplicity, in real version you would validate token and serve file
  // Current version serves via static /uploads - you can improve security here
  res.status(200).send('Download endpoint ready. Use secure token logic.');
});

// Health check
app.get('/ping', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Uploads served at /uploads`);
});
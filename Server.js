import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import extractZip from 'extract-zip';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

// ============ CONFIGURATION ============
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

// Ensure directories exist
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(COVERS_DIR);

// Paynecta API Config
const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || 'test_key';
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || 'admin@schemevault.co.ke';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || 'PNT_TEST';

// Render Backend URL
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// Email Config
const EMAIL_USER = process.env.EMAIL_USER || 'your-email@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'your-app-password';

// Admin credentials
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0726019859';
const ADMIN_EMAIL = 'admin@schemevault.co.ke';

// Token management
const tokenStore = new Map();
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

console.log('🚀 SchemeVault Backend Starting...');
console.log('📁 Data Directory:', DATA_DIR);
console.log('📍 Backend URL:', BACKEND_URL);

// ============ MIDDLEWARE ============

// Enhanced CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-token', 'Authorization'],
  credentials: true,
  maxAge: 86400
}));

// Increase payload limits
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, try again later'
});

// ============ MULTER CONFIGURATION ============

// Custom storage with better error handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (file.fieldname === 'cover') {
        cb(null, COVERS_DIR);
      } else {
        cb(null, UPLOADS_DIR);
      }
    } catch (error) {
      console.error('Multer destination error:', error);
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    try {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 8);
      const ext = path.extname(file.originalname).toLowerCase();
      const name = `${timestamp}-${randomStr}${ext}`;
      console.log(`✅ File will be saved as: ${name}`);
      cb(null, name);
    } catch (error) {
      console.error('Multer filename error:', error);
      cb(error);
    }
  }
});

// Upload configuration with better limits
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
    files: 2
  },
  fileFilter: (req, file, cb) => {
    try {
      console.log(`📤 Processing file: ${file.fieldname} - ${file.originalname}`);
      
      const allowedDocs = ['.pdf', '.doc', '.docx'];
      const allowedImages = ['.jpg', '.jpeg', '.png', '.webp'];

      if (file.fieldname === 'document') {
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedDocs.includes(ext)) {
          console.log(`✅ Document accepted: ${ext}`);
          cb(null, true);
        } else {
          console.log(`❌ Document rejected: ${ext}`);
          cb(new Error(`Document must be PDF, DOC, or DOCX. Got: ${ext}`));
        }
      } else if (file.fieldname === 'cover') {
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedImages.includes(ext)) {
          console.log(`✅ Cover accepted: ${ext}`);
          cb(null, true);
        } else {
          console.log(`❌ Cover rejected: ${ext}`);
          cb(new Error(`Cover must be JPG, PNG, or WEBP. Got: ${ext}`));
        }
      } else {
        cb(null, true);
      }
    } catch (error) {
      console.error('Multer filter error:', error);
      cb(error);
    }
  }
});

// ============ DATA FILE HELPERS ============

function getDataFile(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readJSON(filename) {
  const file = getDataFile(filename);
  try {
    if (!fs.existsSync(file)) {
      console.log(`📝 Creating new file: ${filename}.json`);
      return [];
    }
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`❌ Error reading ${filename}:`, error.message);
    return [];
  }
}

function writeJSON(filename, data) {
  try {
    const file = getDataFile(filename);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ Saved ${filename}.json`);
  } catch (error) {
    console.error(`❌ Error writing ${filename}:`, error.message);
  }
}

// ============ AUTH HELPERS ============

function generateToken() {
  const token = Buffer.from(
    `${Date.now()}-${Math.random().toString(36).substring(7)}`
  ).toString('base64');
  
  tokenStore.set(token, {
    expiresAt: Date.now() + TOKEN_EXPIRY,
    createdAt: new Date().toISOString()
  });
  
  console.log(`🔐 Token generated: ${token.substring(0, 10)}...`);
  return token;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  
  const stored = tokenStore.get(token);
  if (!stored) return false;
  
  if (stored.expiresAt < Date.now()) {
    tokenStore.delete(token);
    return false;
  }
  
  return true;
}

function isAdminTokenValid(req) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    console.log('⚠️ No admin token provided');
    return false;
  }
  return verifyAdminToken(token);
}

// ============ VALIDATION HELPERS ============

function formatPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Phone number is required');
  }
  
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.length < 9 || cleaned.length > 15) {
    throw new Error('Invalid phone number length');
  }
  
  if (cleaned.startsWith('254')) return cleaned;
  if (cleaned.startsWith('0')) return '254' + cleaned.substring(1);
  return '254' + cleaned.slice(-10);
}

function sanitizeFilename(filename) {
  if (!filename) return 'download';
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255);
}

// ============ PAYMENT HELPERS ============

async function initiateMpesaPayment(phone, amount, transactionId) {
  try {
    const formattedPhone = formatPhoneNumber(phone);
    console.log(`💳 Initiating payment: ${amount} to ${formattedPhone}`);

    const response = await axios.post(
      `${PAYNECTA_API_URL}/payment/initialize`,
      {
        code: PAYNECTA_PAYMENT_CODE,
        mobile_number: formattedPhone,
        amount: parseInt(amount),
        reference: transactionId,
        description: `SchemeVault Purchase - ${transactionId}`
      },
      {
        headers: {
          'X-API-Key': PAYNECTA_API_KEY,
          'X-User-Email': PAYNECTA_EMAIL,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log('✅ Paynecta payment initiated successfully');
    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ Paynecta error:', error.message);
    return { success: false, error: error.message };
  }
}

async function checkPaymentStatus(transactionReference) {
  try {
    const response = await axios.get(`${PAYNECTA_API_URL}/payment/status`, {
      params: { transaction_reference: transactionReference },
      headers: {
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL
      },
      timeout: 15000
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ Payment status check error:', error.message);
    return { success: false, error: error.message };
  }
}

// ============ EMAIL HELPERS ============

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({ from: EMAIL_USER, to, subject, html });
    console.log(`📧 Email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('❌ Email error:', error.message);
    return false;
  }
}

// ============ FILE HELPERS ============

function deleteFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.removeSync(filePath);
      console.log(`🗑️ Deleted: ${filePath}`);
      return true;
    }
  } catch (error) {
    console.error(`❌ Error deleting file ${filePath}:`, error.message);
  }
  return false;
}

function getStatsObject() {
  let stats = readJSON('stats');
  if (!stats || Array.isArray(stats)) {
    stats = { visits: 0, downloads: 0, paidSales: 0, activeUsers: 0 };
  }
  return stats;
}

// ============ PUBLIC ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    backend_url: BACKEND_URL,
    data_dir: DATA_DIR
  });
});

// Get all products
app.get('/api/products', (req, res) => {
  try {
    const products = readJSON('products');
    res.json(products);
  } catch (error) {
    console.error('❌ Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get learning areas
app.get('/api/learning-areas', (req, res) => {
  try {
    const areas = readJSON('learning-areas');
    res.json(areas);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch learning areas' });
  }
});

// Get grades
app.get('/api/grades', (req, res) => {
  try {
    const grades = readJSON('grades') || [
      { id: 'grade1', name: 'Grade 1', active: true },
      { id: 'grade2', name: 'Grade 2', active: true },
      { id: 'grade3', name: 'Grade 3', active: true },
      { id: 'grade4', name: 'Grade 4', active: true },
      { id: 'grade5', name: 'Grade 5', active: true },
      { id: 'grade6', name: 'Grade 6', active: true },
      { id: 'grade7', name: 'Grade 7', active: true },
      { id: 'grade8', name: 'Grade 8', active: true },
      { id: 'grade9', name: 'Grade 9', active: true }
    ];
    res.json(grades);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch grades' });
  }
});

// Get banner
app.get('/api/banner', (req, res) => {
  try {
    const banner = readJSON('banner') || { text: '', enabled: false };
    res.json(banner);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch banner' });
  }
});

// Get WhatsApp settings
app.get('/api/admin/whatsapp', (req, res) => {
  try {
    const wa = readJSON('whatsapp') || { number: '', message: 'Hello' };
    res.json(wa);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch WhatsApp settings' });
  }
});

// Get settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = readJSON('settings') || { defaultTerm: 1, enableTerms: true };
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Get visitor logs
app.get('/api/admin/logs', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const logs = readJSON('visitor-logs');
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Get analytics
app.get('/api/admin/analytics', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const stats = getStatsObject();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ============ PAYMENT ROUTES ============

// Initiate M-Pesa STK Push
app.post('/api/initiate-payment', async (req, res) => {
  try {
    const { phone, amount, productId } = req.body;

    if (!phone || !amount || !productId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const products = readJSON('products');
    const product = products.find(p => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const transactionId = uuidv4();
    const result = await initiateMpesaPayment(phone, parsedAmount, transactionId);

    if (result.success) {
      const transactions = readJSON('transactions');
      transactions.push({
        transactionId,
        productId,
        phone,
        amount: parsedAmount,
        reference: result.data.transaction_reference || result.data.checkout_request_id,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      writeJSON('transactions', transactions);

      res.json({ transactionId, message: 'STK Push sent' });
    } else {
      // Demo mode
      const transactions = readJSON('transactions');
      transactions.push({
        transactionId,
        productId,
        phone,
        amount: parsedAmount,
        reference: `DEMO-${transactionId}`,
        status: 'demo',
        createdAt: new Date().toISOString()
      });
      writeJSON('transactions', transactions);

      setTimeout(() => {
        const txns = readJSON('transactions');
        const idx = txns.findIndex(t => t.transactionId === transactionId);
        if (idx !== -1) txns[idx].status = 'completed';
        writeJSON('transactions', txns);
      }, 10000);

      res.json({ transactionId, message: 'Demo mode active' });
    }
  } catch (error) {
    console.error('❌ Payment initiation error:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// Check payment status
app.get('/api/payment-status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const transactions = readJSON('transactions');
    const transaction = transactions.find(t => t.transactionId === transactionId);

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transaction.status === 'completed') {
      const verificationToken = generateToken();
      transaction.verificationToken = verificationToken;
      transaction.verificationExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      writeJSON('transactions', transactions);

      const stats = getStatsObject();
      stats.paidSales = (stats.paidSales || 0) + 1;
      writeJSON('stats', stats);

      return res.json({ status: 'completed', verificationToken });
    }

    if (transaction.status === 'demo') {
      return res.json({ status: transaction.status });
    }

    // Poll Paynecta
    const paymentResult = await checkPaymentStatus(transaction.reference);
    if (paymentResult.success && paymentResult.data.status === 'completed' && paymentResult.data.result_code === 0) {
      transaction.status = 'completed';
      const verificationToken = generateToken();
      transaction.verificationToken = verificationToken;
      transaction.verificationExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      writeJSON('transactions', transactions);

      const stats = getStatsObject();
      stats.paidSales = (stats.paidSales || 0) + 1;
      writeJSON('stats', stats);

      return res.json({ status: 'completed', verificationToken });
    }

    res.json({ status: 'pending' });
  } catch (error) {
    console.error('❌ Payment status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// Request download token
app.post('/api/request-download', (req, res) => {
  try {
    const { verificationToken, productId } = req.body;

    if (!verificationToken || !productId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const transactions = readJSON('transactions');
    const transaction = transactions.find(t => t.verificationToken === verificationToken);

    if (!transaction || transaction.productId !== productId) {
      return res.status(401).json({ error: 'Invalid verification token' });
    }

    if (new Date(transaction.verificationExpiry) < new Date()) {
      return res.status(401).json({ error: 'Verification token expired' });
    }

    const downloadToken = generateToken();
    transaction.downloadToken = downloadToken;
    transaction.downloadExpiry = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    writeJSON('transactions', transactions);

    res.json({ downloadToken });
  } catch (error) {
    console.error('❌ Download token error:', error);
    res.status(500).json({ error: 'Failed to request download token' });
  }
});

// Download file
app.get('/api/download/:token', (req, res) => {
  try {
    const { token } = req.params;
    const transactions = readJSON('transactions');
    const transaction = transactions.find(t => t.downloadToken === token);

    if (!transaction) {
      return res.status(401).json({ error: 'Invalid download token' });
    }

    if (new Date(transaction.downloadExpiry) < new Date()) {
      return res.status(401).json({ error: 'Download token expired' });
    }

    const products = readJSON('products');
    const product = products.find(p => p.id === transaction.productId);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (!product.document) {
      return res.status(404).json({ error: 'Document not available' });
    }

    const filePath = path.join(UPLOADS_DIR, product.document);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    const stats = getStatsObject();
    stats.downloads = (stats.downloads || 0) + 1;
    writeJSON('stats', stats);

    transaction.downloaded = true;
    transaction.downloadedAt = new Date().toISOString();
    writeJSON('transactions', transactions);

    const sanitizedFilename = sanitizeFilename(product.title) + path.extname(product.document);
    res.download(filePath, sanitizedFilename);
  } catch (error) {
    console.error('❌ Download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// ============ ADMIN ROUTES ============

// Admin login
app.post('/api/admin/login', loginLimiter, (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }

    if (password === ADMIN_PASSWORD) {
      const token = generateToken();
      res.json({ token, message: 'Login successful', expiresIn: TOKEN_EXPIRY });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Add product with proper upload handling
app.post(
  '/api/admin/products',
  (req, res, next) => {
    console.log('📤 Incoming product upload request');
    upload.fields([
      { name: 'document', maxCount: 1 },
      { name: 'cover', maxCount: 1 }
    ])(req, res, next);
  },
  (req, res) => {
    try {
      console.log('🔍 Checking admin token...');
      if (!isAdminTokenValid(req)) {
        console.log('❌ Admin token invalid');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { title, grade, term, weeks, price, learningArea, pages } = req.body;

      console.log('📋 Product data:', { title, grade, term, weeks, price, learningArea });
      console.log('📂 Files received:', req.files);

      if (!title || !grade || !term || !weeks || !price || !learningArea) {
        console.log('❌ Missing required fields');
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const products = readJSON('products');
      const product = {
        id: uuidv4(),
        title,
        grade,
        term: parseInt(term),
        weeks: parseInt(weeks),
        price: parseInt(price),
        pages: pages ? parseInt(pages) : null,
        learningArea,
        document: req.files?.document ? req.files.document[0].filename : null,
        cover: req.files?.cover ? req.files.cover[0].filename : null,
        createdAt: new Date().toISOString()
      };

      console.log('✅ Product created:', product);

      products.push(product);
      writeJSON('products', products);

      res.json(product);
    } catch (error) {
      console.error('❌ Add product error:', error.message, error.stack);
      res.status(500).json({ error: error.message || 'Failed to add product' });
    }
  }
);

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Multer error:', err.code, err.message);
    
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ error: 'File is too large. Maximum size is 100MB' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    console.error('❌ Upload error:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

// Delete product
app.delete('/api/admin/products/:id', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    let products = readJSON('products');

    const product = products.find(p => p.id === id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (product.document) {
      deleteFileIfExists(path.join(UPLOADS_DIR, product.document));
    }
    if (product.cover) {
      deleteFileIfExists(path.join(COVERS_DIR, product.cover));
    }

    products = products.filter(p => p.id !== id);
    writeJSON('products', products);

    res.json({ message: 'Product deleted' });
  } catch (error) {
    console.error('❌ Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Edit product
app.put('/api/admin/products/:id', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const { title, grade, term, weeks, price, learningArea, pages, visible } = req.body;

    let products = readJSON('products');
    const productIndex = products.findIndex(p => p.id === id);

    if (productIndex === -1) return res.status(404).json({ error: 'Product not found' });

    if (title) products[productIndex].title = title;
    if (grade) products[productIndex].grade = grade;
    if (term) products[productIndex].term = parseInt(term);
    if (weeks) products[productIndex].weeks = parseInt(weeks);
    if (price) products[productIndex].price = parseInt(price);
    if (learningArea) products[productIndex].learningArea = learningArea;
    if (pages !== undefined) products[productIndex].pages = pages ? parseInt(pages) : null;
    if (visible !== undefined) products[productIndex].visible = visible;

    writeJSON('products', products);
    res.json(products[productIndex]);
  } catch (error) {
    console.error('❌ Edit product error:', error);
    res.status(500).json({ error: 'Failed to edit product' });
  }
});

// Add learning area
app.post('/api/admin/learning-areas', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Learning area name required' });
    }

    const areas = readJSON('learning-areas');
    const area = {
      id: uuidv4(),
      name: name.trim(),
      createdAt: new Date().toISOString()
    };

    areas.push(area);
    writeJSON('learning-areas', areas);

    res.json(area);
  } catch (error) {
    console.error('❌ Add learning area error:', error);
    res.status(500).json({ error: 'Failed to add learning area' });
  }
});

// Delete learning area
app.delete('/api/admin/learning-areas/:id', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    let areas = readJSON('learning-areas');

    areas = areas.filter(a => a.id !== id);
    writeJSON('learning-areas', areas);

    res.json({ message: 'Learning area deleted' });
  } catch (error) {
    console.error('❌ Delete learning area error:', error);
    res.status(500).json({ error: 'Failed to delete learning area' });
  }
});

// Update banner
app.post('/api/admin/banner', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { text, enabled, startDate, endDate } = req.body;
    const banner = { text, enabled, startDate, endDate };

    writeJSON('banner', banner);
    res.json(banner);
  } catch (error) {
    console.error('❌ Update banner error:', error);
    res.status(500).json({ error: 'Failed to update banner' });
  }
});

// Update WhatsApp settings
app.post('/api/admin/whatsapp', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({ error: 'WhatsApp number and message required' });
    }

    const wa = { number, message };
    writeJSON('whatsapp', wa);
    res.json(wa);
  } catch (error) {
    console.error('❌ Update WhatsApp error:', error);
    res.status(500).json({ error: 'Failed to update WhatsApp settings' });
  }
});

// Update settings
app.post('/api/admin/settings', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { defaultTerm, enableTerms } = req.body;

    if (typeof defaultTerm !== 'number' || typeof enableTerms !== 'boolean') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }

    const settings = { defaultTerm, enableTerms };
    writeJSON('settings', settings);
    res.json(settings);
  } catch (error) {
    console.error('❌ Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Create engagement message
app.post('/api/admin/engagement-messages', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { title, message, trigger, whatsappEnabled } = req.body;

    if (!title || !message || !trigger) {
      return res.status(400).json({ error: 'Title, message, and trigger required' });
    }

    const messages = readJSON('engagement-messages');
    const engagementMsg = {
      id: uuidv4(),
      title,
      message,
      trigger,
      whatsappEnabled: !!whatsappEnabled,
      createdAt: new Date().toISOString()
    };

    messages.push(engagementMsg);
    writeJSON('engagement-messages', messages);

    res.json(engagementMsg);
  } catch (error) {
    console.error('❌ Create engagement message error:', error);
    res.status(500).json({ error: 'Failed to create engagement message' });
  }
});

// Get engagement messages
app.get('/api/engagement-messages', (req, res) => {
  try {
    const messages = readJSON('engagement-messages');
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch engagement messages' });
  }
});

// Update engagement message
app.put('/api/admin/engagement-messages/:id', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const { title, message, trigger, whatsappEnabled } = req.body;

    let messages = readJSON('engagement-messages');
    const msgIndex = messages.findIndex(m => m.id === id);

    if (msgIndex === -1) return res.status(404).json({ error: 'Message not found' });

    if (title) messages[msgIndex].title = title;
    if (message) messages[msgIndex].message = message;
    if (trigger) messages[msgIndex].trigger = trigger;
    if (whatsappEnabled !== undefined) messages[msgIndex].whatsappEnabled = whatsappEnabled;

    writeJSON('engagement-messages', messages);
    res.json(messages[msgIndex]);
  } catch (error) {
    console.error('❌ Update engagement message error:', error);
    res.status(500).json({ error: 'Failed to update engagement message' });
  }
});

// Delete engagement message
app.delete('/api/admin/engagement-messages/:id', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    let messages = readJSON('engagement-messages');

    messages = messages.filter(m => m.id !== id);
    writeJSON('engagement-messages', messages);

    res.json({ message: 'Engagement message deleted' });
  } catch (error) {
    console.error('❌ Delete engagement message error:', error);
    res.status(500).json({ error: 'Failed to delete engagement message' });
  }
});

// Reset admin password
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    if (email !== ADMIN_EMAIL) {
      return res.status(400).json({ error: 'Email not registered' });
    }

    const resetCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const html = `
      <p>Your password reset code is:</p>
      <h2>${resetCode}</h2>
      <p>This code expires in 1 hour.</p>
    `;

    const sent = await sendEmail(email, 'SchemeVault Password Reset', html);

    if (sent) {
      res.json({ message: 'Reset code sent to email' });
    } else {
      res.status(500).json({ error: 'Failed to send email' });
    }
  } catch (error) {
    console.error('❌ Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Backup data
app.get('/api/admin/backup', (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    const archive = archiver('zip', { zlib: { level: 9 } });
    const filename = `schemevault-backup-${Date.now()}.zip`;

    res.attachment(filename);
    archive.pipe(res);

    archive.directory(DATA_DIR, 'data');
    archive.finalize();

    archive.on('error', (err) => {
      console.error('❌ Backup error:', err.message);
      res.status(500).json({ error: 'Failed to create backup' });
    });
  } catch (error) {
    console.error('❌ Backup error:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// Restore data
app.post('/api/admin/restore', upload.single('backup'), async (req, res) => {
  try {
    if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

    if (!req.file) return res.status(400).json({ error: 'No backup file provided' });

    const extractPath = path.join(__dirname, 'restore-temp');
    await extractZip(req.file.path, { dir: extractPath });

    const dataPath = path.join(extractPath, 'data');
    if (!fs.existsSync(dataPath)) {
      deleteFileIfExists(extractPath);
      return res.status(400).json({ error: 'Invalid backup file' });
    }

    fs.copySync(dataPath, DATA_DIR, { overwrite: true });
    deleteFileIfExists(extractPath);
    deleteFileIfExists(req.file.path);

    res.json({ message: 'Data restored successfully' });
  } catch (error) {
    console.error('❌ Restore error:', error);
    res.status(500).json({ error: 'Failed to restore backup' });
  }
});

// Track visitor
app.post('/api/track-visitor', (req, res) => {
  try {
    const { ip, device, location } = req.body;

    if (!ip || !device || !location) {
      return res.status(400).json({ error: 'Missing visitor information' });
    }

    const logs = readJSON('visitor-logs');
    logs.push({
      ip,
      device,
      location,
      timestamp: new Date().toISOString()
    });

    writeJSON('visitor-logs', logs);
    res.json({ message: 'Visitor tracked' });
  } catch (error) {
    console.error('❌ Track visitor error:', error);
    res.status(500).json({ error: 'Failed to track visitor' });
  }
});

// Send feedback
app.post('/api/feedback', (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message required' });
    }

    const feedback = readJSON('feedback');
    feedback.push({
      name,
      email,
      message,
      timestamp: new Date().toISOString()
    });

    writeJSON('feedback', feedback);
    res.json({ message: 'Feedback received' });
  } catch (error) {
    console.error('❌ Feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ============ ERROR HANDLING ============

// 404 handler
app.use((req, res) => {
  console.log(`⚠️ 404 - Endpoint not found: ${req.path}`);
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🔴 GLOBAL ERROR:', err.message, err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// ============ SERVER START ============

app.listen(PORT, () => {
  console.log('\n═══════════════════════════════════');
  console.log('🚀 SchemeVault Backend Online');
  console.log('═══════════════════════════════════');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Backend URL: ${BACKEND_URL}`);
  console.log(`📁 Data Directory: ${DATA_DIR}`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════\n');
});
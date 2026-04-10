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
const DATA_DIR = path.join(__dirname, 'data');
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

// Email Config
const EMAIL_USER = process.env.EMAIL_USER || 'your-email@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'your-app-password';

// Admin password (stored as plain text for demo - use hash in production)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0726019859';
const ADMIN_EMAIL = 'admin@schemevault.co.ke';

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts, try again later'
});

// Multer Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'cover') {
      cb(null, COVERS_DIR);
    } else {
      cb(null, UPLOADS_DIR);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const name = `${timestamp}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedDocs = ['.pdf', '.doc', '.docx'];
    const allowedImages = ['.jpg', '.jpeg', '.png', '.webp'];

    if (file.fieldname === 'document') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedDocs.includes(ext)) cb(null, true);
      else cb(new Error('Document must be PDF, DOC, or DOCX'));
    } else if (file.fieldname === 'cover') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedImages.includes(ext)) cb(null, true);
      else cb(new Error('Cover must be JPG, PNG, or WEBP'));
    } else {
      cb(null, true);
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
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeJSON(filename, data) {
  const file = getDataFile(filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function getCacheVersion() {
  return Math.floor(Date.now() / 1000);
}

// ============ AUTH HELPERS ============
function generateToken() {
  return Buffer.from(`${Date.now()}-${Math.random().toString(36).substring(7)}`).toString('base64');
}

function verifyAdminToken(token) {
  // In production, verify JWT or validate against stored tokens
  return token === process.env.ADMIN_TOKEN || token.length > 10;
}

function isAdminTokenValid(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  return verifyAdminToken(token);
}

// ============ PAYMENT HELPERS ============
async function initiateMpesaPayment(phone, amount, transactionId) {
  try {
    const formattedPhone = phone.startsWith('0') ? '254' + phone.substring(1) : phone;

    const response = await axios.post(`${PAYNECTA_API_URL}/payment/initialize`, {
      code: PAYNECTA_PAYMENT_CODE,
      mobile_number: formattedPhone,
      amount: parseInt(amount),
      reference: transactionId,
      description: `SchemeVault Purchase - ${transactionId}`
    }, {
      headers: {
        'X-API-Key': PAYNECTA_API_KEY,
        'X-User-Email': PAYNECTA_EMAIL,
        'Content-Type': 'application/json'
      }
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error('Paynecta error:', error.message);
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
      }
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error('Payment status check error:', error.message);
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
    return true;
  } catch (error) {
    console.error('Email error:', error);
    return false;
  }
}

// ============ PUBLIC ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get all products
app.get('/api/products', (req, res) => {
  const products = readJSON('products');
  res.json(products);
});

// Get learning areas
app.get('/api/learning-areas', (req, res) => {
  const areas = readJSON('learning-areas');
  res.json(areas);
});

// Get grades
app.get('/api/grades', (req, res) => {
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
});

// Get banner
app.get('/api/banner', (req, res) => {
  const banner = readJSON('banner') || { text: '', enabled: false };
  res.json(banner);
});

// Get WhatsApp settings
app.get('/api/admin/whatsapp', (req, res) => {
  const wa = readJSON('whatsapp') || { number: '', message: 'Hello' };
  res.json(wa);
});

// Get all learning areas and default settings
app.get('/api/settings', (req, res) => {
  const settings = readJSON('settings') || { defaultTerm: 1, enableTerms: true };
  res.json(settings);
});

// Get visitor logs
app.get('/api/admin/logs', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });
  const logs = readJSON('visitor-logs');
  res.json(logs);
});

// Get analytics
app.get('/api/admin/analytics', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });
  const stats = readJSON('stats');
  res.json(stats);
});

// ============ PAYMENT ROUTES ============

// Initiate M-Pesa STK Push
app.post('/api/initiate-payment', async (req, res) => {
  const { phone, amount, productId } = req.body;

  if (!phone || !amount || !productId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const transactionId = uuidv4();
  const result = await initiateMpesaPayment(phone, amount, transactionId);

  if (result.success) {
    // Store transaction for status polling
    const transactions = readJSON('transactions');
    transactions.push({
      transactionId,
      productId,
      phone,
      amount,
      reference: result.data.transaction_reference || result.data.checkout_request_id,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    writeJSON('transactions', transactions);

    res.json({ transactionId, message: 'STK Push sent' });
  } else {
    // Demo mode fallback
    const transactions = readJSON('transactions');
    transactions.push({
      transactionId,
      productId,
      phone,
      amount,
      reference: `DEMO-${transactionId}`,
      status: 'demo',
      createdAt: new Date().toISOString()
    });
    writeJSON('transactions', transactions);

    // Auto-confirm after 10 seconds in demo mode
    setTimeout(() => {
      const txns = readJSON('transactions');
      const idx = txns.findIndex(t => t.transactionId === transactionId);
      if (idx !== -1) txns[idx].status = 'completed';
      writeJSON('transactions', txns);
    }, 10000);

    res.json({ transactionId, message: 'Demo mode: Payment will auto-confirm in 10s' });
  }
});

// Check payment status
app.get('/api/payment-status/:transactionId', async (req, res) => {
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

    // Update stats
    const stats = readJSON('stats');
    stats.paidSales = (stats.paidSales || 0) + 1;
    writeJSON('stats', stats);

    return res.json({ status: 'completed', verificationToken });
  }

  if (transaction.status === 'demo') {
    return res.json({ status: transaction.status });
  }

  // Poll Paynecta if still pending
  const paymentResult = await checkPaymentStatus(transaction.reference);
  if (paymentResult.success && paymentResult.data.status === 'completed' && paymentResult.data.result_code === 0) {
    transaction.status = 'completed';
    const verificationToken = generateToken();
    transaction.verificationToken = verificationToken;
    transaction.verificationExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    writeJSON('transactions', transactions);

    const stats = readJSON('stats');
    stats.paidSales = (stats.paidSales || 0) + 1;
    writeJSON('stats', stats);

    return res.json({ status: 'completed', verificationToken });
  }

  res.json({ status: 'pending' });
});

// Request download token
app.post('/api/request-download', (req, res) => {
  const { verificationToken, productId } = req.body;
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
});

// Download file
app.get('/api/download/:token', (req, res) => {
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

  const filePath = path.join(UPLOADS_DIR, product.document);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Update stats
  const stats = readJSON('stats');
  stats.downloads = (stats.downloads || 0) + 1;
  writeJSON('stats', stats);

  // Mark download as completed
  transaction.downloaded = true;
  transaction.downloadedAt = new Date().toISOString();
  writeJSON('transactions', transactions);

  res.download(filePath, product.title + path.extname(product.document));
});

// ============ ADMIN ROUTES ============

// Admin login
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    const token = generateToken();
    res.json({ token, message: 'Login successful' });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Add product
app.post('/api/admin/products', upload.fields([{ name: 'document', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { title, grade, term, weeks, price, learningArea, pages } = req.body;

  if (!title || !grade || !term || !weeks || !price || !learningArea) {
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
    document: req.files.document ? req.files.document[0].filename : null,
    cover: req.files.cover ? req.files.cover[0].filename : null,
    createdAt: new Date().toISOString()
  };

  products.push(product);
  writeJSON('products', products);

  res.json(product);
});

// Delete product
app.delete('/api/admin/products/:id', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  let products = readJSON('products');

  const product = products.find(p => p.id === id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  if (product.document) {
    fs.removeSync(path.join(UPLOADS_DIR, product.document));
  }
  if (product.cover) {
    fs.removeSync(path.join(COVERS_DIR, product.cover));
  }

  products = products.filter(p => p.id !== id);
  writeJSON('products', products);

  res.json({ message: 'Product deleted' });
});

// Edit product
app.put('/api/admin/products/:id', (req, res) => {
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
});

// Add learning area
app.post('/api/admin/learning-areas', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Missing name' });
  }

  const areas = readJSON('learning-areas');
  const area = {
    id: uuidv4(),
    name,
    createdAt: new Date().toISOString()
  };

  areas.push(area);
  writeJSON('learning-areas', areas);

  res.json(area);
});

// Delete learning area
app.delete('/api/admin/learning-areas/:id', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  let areas = readJSON('learning-areas');

  areas = areas.filter(a => a.id !== id);
  writeJSON('learning-areas', areas);

  res.json({ message: 'Learning area deleted' });
});

// Update banner
app.post('/api/admin/banner', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { text, enabled, startDate, endDate } = req.body;
  const banner = { text, enabled, startDate, endDate };

  writeJSON('banner', banner);
  res.json(banner);
});

// Update WhatsApp settings
app.post('/api/admin/whatsapp', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { number, message } = req.body;
  const wa = { number, message };

  writeJSON('whatsapp', wa);
  res.json(wa);
});

// Update settings
app.post('/api/admin/settings', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { defaultTerm, enableTerms } = req.body;
  const settings = { defaultTerm, enableTerms };

  writeJSON('settings', settings);
  res.json(settings);
});

// Create engagement message
app.post('/api/admin/engagement-messages', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { title, message, trigger, whatsappEnabled } = req.body;

  const messages = readJSON('engagement-messages');
  const engagementMsg = {
    id: uuidv4(),
    title,
    message,
    trigger,
    whatsappEnabled,
    createdAt: new Date().toISOString()
  };

  messages.push(engagementMsg);
  writeJSON('engagement-messages', messages);

  res.json(engagementMsg);
});

// Get engagement messages
app.get('/api/engagement-messages', (req, res) => {
  const messages = readJSON('engagement-messages');
  res.json(messages);
});

// Update engagement message
app.put('/api/admin/engagement-messages/:id', (req, res) => {
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
});

// Delete engagement message
app.delete('/api/admin/engagement-messages/:id', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  let messages = readJSON('engagement-messages');

  messages = messages.filter(m => m.id !== id);
  writeJSON('engagement-messages', messages);

  res.json({ message: 'Engagement message deleted' });
});

// Reset admin password
app.post('/api/admin/reset-password', async (req, res) => {
  const { email } = req.body;

  if (email !== ADMIN_EMAIL) {
    return res.status(400).json({ error: 'Email not registered' });
  }

  const resetCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  const html = `<p>Your password reset code is: <strong>${resetCode}</strong></p>`;

  const sent = await sendEmail(email, 'SchemeVault Password Reset', html);

  if (sent) {
    res.json({ message: 'Reset code sent to email' });
  } else {
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Backup data
app.get('/api/admin/backup', (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  const archive = archiver('zip', { zlib: { level: 9 } });
  const filename = `schemevault-backup-${Date.now()}.zip`;

  res.attachment(filename);
  archive.pipe(res);

  archive.directory(DATA_DIR, 'data');
  archive.finalize();
});

// Restore data
app.post('/api/admin/restore', upload.single('backup'), async (req, res) => {
  if (!isAdminTokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!req.file) return res.status(400).json({ error: 'No backup file provided' });

  try {
    const extractPath = path.join(__dirname, 'restore-temp');
    await extractZip(req.file.path, { dir: extractPath });

    // Copy data back
    fs.copySync(path.join(extractPath, 'data'), DATA_DIR, { overwrite: true });
    fs.removeSync(extractPath);
    fs.removeSync(req.file.path);

    res.json({ message: 'Data restored successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Restore failed' });
  }
});

// Track visitor
app.post('/api/track-visitor', (req, res) => {
  const { ip, device, location } = req.body;

  const logs = readJSON('visitor-logs');
  logs.push({
    ip,
    device,
    location,
    timestamp: new Date().toISOString()
  });

  writeJSON('visitor-logs', logs);
  res.json({ message: 'Visitor tracked' });
});

// Send feedback
app.post('/api/feedback', (req, res) => {
  const { name, email, message } = req.body;

  const feedback = readJSON('feedback');
  feedback.push({
    name,
    email,
    message,
    timestamp: new Date().toISOString()
  });

  writeJSON('feedback', feedback);
  res.json({ message: 'Feedback received' });
});

// ============ ERROR HANDLING ============

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============ SERVER START ============

app.listen(PORT, () => {
  console.log(`SchemeVault server running on port ${PORT}`);
});
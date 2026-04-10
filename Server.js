const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Configuration ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const ADMIN_PASSWORD = '0726019859';
const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://paynecta.co.ke/api/v1';
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || '';
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || '';
const PAYNECTA_PAYMENT_CODE = process.env.PAYNECTA_PAYMENT_CODE || '';

// Email configuration for password reset
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || EMAIL_USER;

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, COVERS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ---------- Data Helpers ----------
const readJSON = (file) => {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) return [];
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return []; }
};
const writeJSON = (file, data) => fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));

// In-memory stores
const pendingPayments = new Map();
const downloadTokens = new Map();
const verificationTokens = new Map();
const resetCodes = new Map();

// Cache version for frontend sync
let cacheVersion = 1;
const bumpCache = () => { cacheVersion++; };

// Load dynamic password if exists
let currentAdminPassword = ADMIN_PASSWORD;
try {
  const config = readJSON('config.json');
  if (config.adminPassword) currentAdminPassword = config.adminPassword;
} catch (e) {}

// ---------- Middleware ----------
app.use(cors({
  origin: [
    'https://schemevault.onrender.com',
    'https://schemevault-frontend.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Token']
}));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/covers', express.static(COVERS_DIR));

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isCover = req.path.includes('cover');
    const dest = isCover ? COVERS_DIR : UPLOADS_DIR;
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
  }
});
const fileFilter = (req, file, cb) => {
  const allowedDoc = /\.(pdf|doc|docx)$/i;
  const allowedImg = /\.(jpeg|jpg|png|webp)$/i;
  const isCover = req.path.includes('cover');
  const ext = path.extname(file.originalname);
  if ((isCover && allowedImg.test(ext)) || (!isCover && allowedDoc.test(ext))) {
    cb(null, true);
  } else {
    cb(new Error(isCover ? 'Only JPEG, PNG, WEBP images allowed' : 'Only PDF, DOC, DOCX allowed'));
  }
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// ---------- Auth Middleware ----------
const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token === Buffer.from(currentAdminPassword).toString('base64')) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// ---------- Helper: Visitor Logging ----------
const logVisit = (req) => {
  const logs = readJSON('visits.json');
  logs.push({
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    timestamp: new Date().toISOString(),
  });
  writeJSON('visits.json', logs.slice(-1000));
  const stats = readJSON('stats.json') || { visits: 0, downloads: 0, payments: 0 };
  stats.visits = (stats.visits || 0) + 1;
  writeJSON('stats.json', stats);
};

app.use((req, res, next) => { if (req.method === 'GET') logVisit(req); next(); });

// ---------- PUBLIC ENDPOINTS (Unified Naming) ----------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/products', (req, res) => {
  const products = readJSON('products.json');
  res.json(products);
});

app.get('/api/banner', (req, res) => {
  const banner = readJSON('banner.json') || { text: '', enabled: false };
  res.json(banner);
});

// Public WhatsApp settings – matches frontend expectation
app.get('/api/admin/whatsapp', (req, res) => {
  const wa = readJSON('whatsapp.json') || { enabled: false, number: '', message: 'Hello' };
  res.json(wa);
});

// Term settings – public read
app.get('/api/term-settings', (req, res) => {
  const terms = readJSON('terms.json') || { enabled: [1,2,3], default: 1 };
  res.json({
    term1: terms.enabled.includes(1),
    term2: terms.enabled.includes(2),
    term3: terms.enabled.includes(3),
    defaultTerm: terms.default
  });
});

app.get('/api/popups', (req, res) => {
  const popups = readJSON('popups.json') || [];
  res.json(popups);
});

app.post('/api/submit-feedback', (req, res) => {
  const { message, whatsapp } = req.body;
  const feedbacks = readJSON('feedback.json') || [];
  feedbacks.push({ id: uuidv4(), message, whatsapp, timestamp: new Date().toISOString() });
  writeJSON('feedback.json', feedbacks);
  res.json({ success: true });
});

app.get('/api/cache-version', (req, res) => {
  res.json({ version: cacheVersion });
});

app.get('/api/grades', (req, res) => {
  let grades = readJSON('grades.json');
  if (!grades.length) {
    grades = Array.from({ length: 9 }, (_, i) => ({ name: `Grade ${i+1}`, active: true }));
    writeJSON('grades.json', grades);
  }
  res.json(grades);
});

app.get('/api/learning-areas', (req, res) => {
  const areas = readJSON('subjects.json') || [];
  res.json(areas);
});

app.post('/api/track-visit', (req, res) => {
  logVisit(req);
  res.json({ success: true });
});

app.post('/api/heartbeat', (req, res) => {
  const { sessionId } = req.body;
  const sessions = readJSON('sessions.json') || {};
  sessions[sessionId] = Date.now();
  writeJSON('sessions.json', sessions);
  res.json({ success: true });
});

app.post('/api/leave', (req, res) => {
  const { sessionId } = req.body;
  const sessions = readJSON('sessions.json') || {};
  delete sessions[sessionId];
  writeJSON('sessions.json', sessions);
  res.json({ success: true });
});

// ---------- PAYMENT FLOW (Robust & Secure) ----------
app.post('/api/initiate-payment', async (req, res) => {
  console.log('=== PAYMENT INITIATION ===');
  console.log('Request body:', JSON.stringify(req.body));
  
  const { phone, amount, productId } = req.body;
  
  if (!phone || !amount || !productId) {
    console.log('Missing fields');
    return res.status(400).json({ error: 'Phone, amount, and product ID are required' });
  }
  
  const product = readJSON('products.json').find(p => p.id === productId);
  if (!product) {
    console.log('Product not found:', productId);
    return res.status(404).json({ error: 'Product not found' });
  }

  const transactionId = uuidv4();
  const formattedPhone = phone.replace(/^0/, '254').replace(/\D/g, '');
  
  console.log('Formatted phone:', formattedPhone);
  console.log('Amount:', amount);
  console.log('Product:', product.title);

  const pending = {
    transactionId,
    productId,
    amount,
    phone: formattedPhone,
    status: 'pending',
    createdAt: Date.now(),
    fileUrl: product.fileUrl,
  };
  pendingPayments.set(transactionId, pending);

  console.log('Paynecta credentials present:', {
    apiKey: !!PAYNECTA_API_KEY,
    email: !!PAYNECTA_EMAIL,
    paymentCode: !!PAYNECTA_PAYMENT_CODE
  });

  // Demo mode if credentials missing
  if (!PAYNECTA_API_KEY || !PAYNECTA_EMAIL || !PAYNECTA_PAYMENT_CODE) {
    console.log('Demo mode: auto-confirm after 10s');
    setTimeout(() => {
      const p = pendingPayments.get(transactionId);
      if (p) p.status = 'completed';
    }, 10000);
    return res.json({ success: true, transactionId, demo: true });
  }

  try {
    const payload = {
      payment_code: PAYNECTA_PAYMENT_CODE,
      mobile_number: formattedPhone,   // Change to "phone_number" if required by Paynecta
      amount: String(amount)           // Some gateways require string
    };
    
    console.log('Paynecta request payload:', JSON.stringify(payload));
    console.log('Paynecta URL:', `${PAYNECTA_API_URL}/payment/initialize`);
    
    const response = await axios.post(
      `${PAYNECTA_API_URL}/payment/initialize`,
      payload,
      {
        headers: {
          'X-API-Key': PAYNECTA_API_KEY,
          'X-User-Email': PAYNECTA_EMAIL,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    
    console.log('Paynecta response status:', response.status);
    console.log('Paynecta response data:', JSON.stringify(response.data));
    
    const { transaction_reference, checkout_request_id } = response.data;
    const reference = transaction_reference || checkout_request_id;
    
    if (!reference) {
      console.error('No transaction reference in response');
      throw new Error('No transaction reference received from Paynecta');
    }
    
    pending.transaction_reference = reference;
    pendingPayments.set(transactionId, pending);
    
    res.json({ success: true, transactionId });
    
  } catch (error) {
    console.error('=== PAYNECTA ERROR ===');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data));
    } else if (error.request) {
      console.error('No response received. Error code:', error.code);
    } else {
      console.error('Error message:', error.message);
    }
    
    pending.status = 'failed';
    pendingPayments.set(transactionId, pending);
    
    let errorMessage = 'Payment initiation failed';
    if (error.response?.data?.message) {
      errorMessage = error.response.data.message;
    } else if (error.response?.data?.error) {
      errorMessage = error.response.data.error;
    } else if (error.response?.status === 401) {
      errorMessage = 'Invalid API credentials';
    } else if (error.response?.status === 400) {
      errorMessage = 'Invalid request – check payment code or phone number';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Payment gateway timeout';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Cannot reach payment gateway';
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

app.get('/api/payment-status/:transactionId', async (req, res) => {
  const { transactionId } = req.params;
  const pending = pendingPayments.get(transactionId);
  if (!pending) return res.status(404).json({ error: 'Transaction not found' });

  if (pending.status === 'completed') {
    const token = uuidv4();
    verificationTokens.set(token, { productId: pending.productId, expires: Date.now() + 5 * 60 * 1000 });
    return res.json({ status: 'success', verified: true, token });
  }

  if (pending.status === 'failed') return res.json({ status: 'failed' });

  if (pending.transaction_reference && PAYNECTA_API_KEY) {
    try {
      const response = await axios.get(`${PAYNECTA_API_URL}/payment/status`, {
        params: { transaction_reference: pending.transaction_reference },
        headers: { 'X-API-Key': PAYNECTA_API_KEY, 'X-User-Email': PAYNECTA_EMAIL }
      });
      const data = response.data;
      if (data.status === 'completed' && data.result_code === '0') {
        pending.status = 'completed';
        pendingPayments.set(transactionId, pending);
        const stats = readJSON('stats.json') || {};
        stats.payments = (stats.payments || 0) + 1;
        writeJSON('stats.json', stats);
        const payments = readJSON('payments.json');
        payments.push({ transactionId, productId: pending.productId, amount: pending.amount, timestamp: new Date().toISOString() });
        writeJSON('payments.json', payments);
        bumpCache();
        const token = uuidv4();
        verificationTokens.set(token, { productId: pending.productId, expires: Date.now() + 5 * 60 * 1000 });
        return res.json({ status: 'success', verified: true, token });
      }
    } catch (e) { /* ignore */ }
  }
  res.json({ status: 'pending' });
});

app.post('/api/request-download', (req, res) => {
  const { verificationToken, productId } = req.body;
  const v = verificationTokens.get(verificationToken);
  if (!v || v.productId !== productId || v.expires < Date.now()) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  verificationTokens.delete(verificationToken);
  const downloadToken = uuidv4();
  downloadTokens.set(downloadToken, { productId, expires: Date.now() + 2 * 60 * 1000 });
  const stats = readJSON('stats.json') || {};
  stats.downloads = (stats.downloads || 0) + 1;
  writeJSON('stats.json', stats);
  const downloads = readJSON('downloads.json');
  downloads.push({ productId, timestamp: new Date().toISOString() });
  writeJSON('downloads.json', downloads);
  bumpCache();
  res.json({ success: true, token: downloadToken });
});

app.get('/api/download/:token', (req, res) => {
  const { token } = req.params;
  const d = downloadTokens.get(token);
  if (!d || d.expires < Date.now()) return res.status(403).send('Invalid or expired download link');
  const product = readJSON('products.json').find(p => p.id === d.productId);
  if (!product) return res.status(404).send('Product not found');
  downloadTokens.delete(token);
  const filePath = path.join(UPLOADS_DIR, path.basename(product.fileUrl));
  res.download(filePath, product.title + path.extname(filePath));
});

// ---------- PASSWORD RESET ----------
app.post('/api/admin/forgot-password', async (req, res) => {
  const adminEmail = ADMIN_EMAIL;
  if (!adminEmail) return res.status(500).json({ error: 'Admin email not configured' });
  
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  resetCodes.set(adminEmail, { code, expires: Date.now() + 15 * 60 * 1000 });
  
  if (EMAIL_USER && EMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: { user: EMAIL_USER, pass: EMAIL_PASS }
      });
      await transporter.sendMail({
        from: `"SchemeVault" <${EMAIL_USER}>`,
        to: adminEmail,
        subject: 'Password Reset Code',
        text: `Your reset code is: ${code}\nValid for 15 minutes.`
      });
      res.json({ success: true, email: adminEmail });
    } catch (e) {
      console.error('Email error:', e);
      res.status(500).json({ error: 'Failed to send email' });
    }
  } else {
    res.json({ success: true, email: adminEmail, code });
  }
});

app.post('/api/admin/reset-password', (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  
  const stored = resetCodes.get(email);
  if (!stored || stored.code !== code || stored.expires < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  
  const config = readJSON('config.json') || {};
  config.adminPassword = newPassword;
  writeJSON('config.json', config);
  currentAdminPassword = newPassword;
  
  resetCodes.delete(email);
  res.json({ success: true });
});

// ---------- ADMIN ENDPOINTS ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== currentAdminPassword) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: Buffer.from(currentAdminPassword).toString('base64') });
});

// Subjects
app.get('/api/admin/subjects', adminAuth, (req, res) => res.json(readJSON('subjects.json')));
app.post('/api/admin/subjects', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const subjects = readJSON('subjects.json');
  const newSubject = { id: uuidv4(), name };
  subjects.push(newSubject);
  writeJSON('subjects.json', subjects);
  bumpCache();
  res.json(newSubject);
});
app.delete('/api/admin/subjects/:id', adminAuth, (req, res) => {
  let subjects = readJSON('subjects.json');
  subjects = subjects.filter(s => s.id !== req.params.id);
  writeJSON('subjects.json', subjects);
  bumpCache();
  res.json({ success: true });
});

// Products upload
app.post('/api/admin/products', adminAuth, upload.fields([{ name: 'document', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  if (!req.files || !req.files['document']) {
    return res.status(400).json({ error: 'Document file required' });
  }
  const { title, grade, subject, term, weeks, price, pages, visibility } = req.body;
  const docFile = req.files['document'][0];
  const coverFile = req.files['cover'] ? req.files['cover'][0] : null;
  
  const products = readJSON('products.json');
  const newProduct = {
    id: uuidv4(),
    title,
    grade,
    subject,
    term: parseInt(term),
    weeks: parseInt(weeks),
    price: parseFloat(price),
    pages: pages || '',
    fileUrl: `/uploads/${docFile.filename}`,
    coverUrl: coverFile ? `/covers/${coverFile.filename}` : null,
    visibility: visibility === 'true' || visibility === true,
    createdAt: new Date().toISOString()
  };
  products.push(newProduct);
  writeJSON('products.json', products);
  bumpCache();
  res.json(newProduct);
});

app.put('/api/admin/products/:id', adminAuth, (req, res) => {
  const products = readJSON('products.json');
  const index = products.findIndex(p => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  products[index] = { ...products[index], ...req.body };
  writeJSON('products.json', products);
  bumpCache();
  res.json(products[index]);
});

app.delete('/api/admin/products/:id', adminAuth, (req, res) => {
  let products = readJSON('products.json');
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  try { if (product.fileUrl) fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(product.fileUrl))); } catch {}
  try { if (product.coverUrl) fs.unlinkSync(path.join(COVERS_DIR, path.basename(product.coverUrl))); } catch {}
  products = products.filter(p => p.id !== req.params.id);
  writeJSON('products.json', products);
  bumpCache();
  res.json({ success: true });
});

// Terms (admin write)
app.get('/api/admin/terms', adminAuth, (req, res) => res.json(readJSON('terms.json') || { enabled: [1,2,3], default: 1 }));
app.post('/api/admin/terms', adminAuth, (req, res) => {
  writeJSON('terms.json', req.body);
  bumpCache();
  res.json({ success: true });
});

// Banner
app.get('/api/admin/banner', adminAuth, (req, res) => res.json(readJSON('banner.json') || {}));
app.post('/api/admin/banner', adminAuth, (req, res) => {
  writeJSON('banner.json', req.body);
  bumpCache();
  res.json({ success: true });
});

// Popups
app.get('/api/admin/popups', adminAuth, (req, res) => res.json(readJSON('popups.json')));
app.post('/api/admin/popups', adminAuth, (req, res) => {
  const popups = readJSON('popups.json');
  const newPopup = { id: uuidv4(), ...req.body };
  popups.push(newPopup);
  writeJSON('popups.json', popups);
  bumpCache();
  res.json(newPopup);
});
app.delete('/api/admin/popups/:id', adminAuth, (req, res) => {
  let popups = readJSON('popups.json');
  popups = popups.filter(p => p.id !== req.params.id);
  writeJSON('popups.json', popups);
  bumpCache();
  res.json({ success: true });
});

// WhatsApp (admin write)
app.get('/api/admin/wa', adminAuth, (req, res) => res.json(readJSON('whatsapp.json') || {}));
app.post('/api/admin/wa', adminAuth, (req, res) => {
  writeJSON('whatsapp.json', req.body);
  bumpCache();
  res.json({ success: true });
});

// Stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = readJSON('stats.json') || { visits: 0, downloads: 0, payments: 0 };
  const sessions = readJSON('sessions.json') || {};
  const activeUsers = Object.values(sessions).filter(ts => Date.now() - ts < 60000).length;
  res.json({ ...stats, activeUsers });
});

// Backup & Restore
app.get('/api/admin/backup', adminAuth, (req, res) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  res.attachment('schemevault-backup.zip');
  archive.pipe(res);
  archive.directory(DATA_DIR, false);
  archive.finalize();
});

app.post('/api/admin/restore', adminAuth, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const zipPath = req.file.path;
  fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: DATA_DIR }))
    .on('close', () => {
      fs.unlinkSync(zipPath);
      bumpCache();
      res.json({ success: true });
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
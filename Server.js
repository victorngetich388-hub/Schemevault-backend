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
  const wa = readJSON('whatsapp') || { number: '', message: 'Hello',
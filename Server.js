const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");
const extractZip = require("extract-zip");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// Ensure data directories exist
const dirs = ["uploads", "covers", "backups"];
dirs.forEach((d) => {
  const p = path.join(DATA_DIR, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// JSON file helpers
function jsonPath(name) { return path.join(DATA_DIR, `${name}.json`); }
function readJSON(name, fallback = []) {
  try { return JSON.parse(fs.readFileSync(jsonPath(name), "utf8")); } catch { return fallback; }
}
function writeJSON(name, data) { fs.writeFileSync(jsonPath(name), JSON.stringify(data, null, 2)); }

// Initialise data files
if (!fs.existsSync(jsonPath("products"))) writeJSON("products", []);
if (!fs.existsSync(jsonPath("subjects"))) writeJSON("subjects", [
  "Mathematics","English","Kiswahili","Science & Technology","Social Studies",
  "CRE","IRE","Creative Arts","Music","Physical Education","Agriculture",
  "Home Science","Life Skills","Indigenous Languages"
]);
if (!fs.existsSync(jsonPath("settings"))) writeJSON("settings", {
  adminPassword: "0726019859",
  enabledTerms: [1, 2, 3],
  defaultTerm: 1,
  banner: { enabled: false, text: "", startDate: null, endDate: null }
});
if (!fs.existsSync(jsonPath("stats"))) writeJSON("stats", { visits: 0, downloads: 0, revenue: 0, payments: [] });
if (!fs.existsSync(jsonPath("visitors"))) writeJSON("visitors", []);
if (!fs.existsSync(jsonPath("engagements"))) writeJSON("engagements", []);
if (!fs.existsSync(jsonPath("transactions"))) writeJSON("transactions", {});

// Middleware
app.use(cors());
app.use(express.json());
app.use("/covers", express.static(path.join(DATA_DIR, "covers")));

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === "cover" ? "covers" : "uploads";
    cb(null, path.join(DATA_DIR, folder));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// Admin auth middleware
function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const ts = parseInt(decoded, 10);
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return res.status(401).json({ error: "Token expired" });
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
}

// ─── PUBLIC ROUTES ───

// Track visitor
app.post("/api/track-visit", (req, res) => {
  const stats = readJSON("stats", {});
  stats.visits = (stats.visits || 0) + 1;
  writeJSON("stats", stats);
  const visitors = readJSON("visitors", []);
  visitors.push({
    ip: req.headers["x-forwarded-for"] || req.ip,
    userAgent: req.headers["user-agent"],
    timestamp: new Date().toISOString(),
  });
  if (visitors.length > 5000) visitors.splice(0, visitors.length - 5000);
  writeJSON("visitors", visitors);
  res.json({ ok: true });
});

// Get public products
app.get("/api/products", (req, res) => {
  const products = readJSON("products", []);
  const visible = products.filter((p) => p.visible !== false);
  // Don't expose file paths
  const safe = visible.map(({ filePath, ...rest }) => rest);
  res.json(safe);
});

// Get subjects
app.get("/api/subjects", (req, res) => {
  res.json(readJSON("subjects", []));
});

// Get settings (public subset)
app.get("/api/settings/public", (req, res) => {
  const s = readJSON("settings", {});
  res.json({
    enabledTerms: s.enabledTerms || [1, 2, 3],
    defaultTerm: s.defaultTerm || 1,
    banner: s.banner || { enabled: false, text: "" },
  });
});

// Get engagements (public)
app.get("/api/engagements", (req, res) => {
  const engagements = readJSON("engagements", []);
  const active = engagements.filter((e) => e.active !== false);
  res.json(active);
});

// ─── PAYMENT ROUTES ───

const PAYNECTA_URL = process.env.PAYNECTA_API_URL;
const PAYNECTA_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL;
const PAYNECTA_CODE = process.env.PAYNECTA_PAYMENT_CODE;
const isDemoMode = !PAYNECTA_URL || !PAYNECTA_KEY || !PAYNECTA_EMAIL || !PAYNECTA_CODE;

app.post("/api/initiate-payment", async (req, res) => {
  try {
    const { phone, amount, productId } = req.body;
    if (!phone || !amount || !productId) return res.status(400).json({ error: "Missing fields" });

    // Format phone
    let formatted = phone.replace(/\D/g, "");
    if (formatted.startsWith("0")) formatted = "254" + formatted.slice(1);
    if (!formatted.startsWith("254")) formatted = "254" + formatted;

    const txId = crypto.randomBytes(8).toString("hex");
    const transactions = readJSON("transactions", {});

    if (isDemoMode) {
      // Demo mode: auto-confirm after 10 seconds
      transactions[txId] = { productId, amount, phone: formatted, status: "pending", demo: true, createdAt: Date.now() };
      writeJSON("transactions", transactions);
      setTimeout(() => {
        const t = readJSON("transactions", {});
        if (t[txId] && t[txId].status === "pending") {
          t[txId].status = "completed";
          writeJSON("transactions", t);
          // Update stats
          const stats = readJSON("stats", {});
          stats.revenue = (stats.revenue || 0) + amount;
          stats.payments = stats.payments || [];
          stats.payments.push({ txId, amount, phone: formatted, productId, date: new Date().toISOString() });
          writeJSON("stats", stats);
        }
      }, 10000);
      return res.json({ transactionId: txId, demo: true });
    }

    // Real Paynecta
    const response = await fetch(`${PAYNECTA_URL}/payment/initialize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": PAYNECTA_KEY, "X-User-Email": PAYNECTA_EMAIL },
      body: JSON.stringify({ code: PAYNECTA_CODE, mobile_number: formatted, amount }),
    });
    const data = await response.json();

    if (!response.ok) return res.status(400).json({ error: data.message || "Payment initiation failed" });

    const ref = data.transaction_reference || data.checkout_request_id || data.data?.transaction_reference;
    transactions[txId] = { productId, amount, phone: formatted, status: "pending", ref, createdAt: Date.now() };
    writeJSON("transactions", transactions);

    res.json({ transactionId: txId });
  } catch (err) {
    console.error("Payment error:", err);
    res.status(500).json({ error: "Payment initiation failed" });
  }
});

app.get("/api/payment-status/:txId", async (req, res) => {
  try {
    const transactions = readJSON("transactions", {});
    const tx = transactions[req.params.txId];
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    if (tx.status === "completed") {
      const vToken = crypto.randomBytes(16).toString("hex");
      tx.verificationToken = vToken;
      tx.vTokenExpiry = Date.now() + 5 * 60 * 1000;
      writeJSON("transactions", transactions);
      return res.json({ status: "completed", verificationToken: vToken });
    }

    if (tx.demo) return res.json({ status: tx.status });

    // Poll Paynecta
    if (tx.ref && PAYNECTA_URL) {
      try {
        const resp = await fetch(`${PAYNECTA_URL}/payment/status?transaction_reference=${tx.ref}`, {
          headers: { "X-API-Key": PAYNECTA_KEY, "X-User-Email": PAYNECTA_EMAIL },
        });
        const data = await resp.json();
        const statusData = data.data || data;

        if (statusData.status === "completed" && (statusData.result_code === 0 || statusData.result_code === "0")) {
          tx.status = "completed";
          const vToken = crypto.randomBytes(16).toString("hex");
          tx.verificationToken = vToken;
          tx.vTokenExpiry = Date.now() + 5 * 60 * 1000;
          writeJSON("transactions", transactions);

          // Update stats
          const stats = readJSON("stats", {});
          stats.revenue = (stats.revenue || 0) + tx.amount;
          stats.payments = stats.payments || [];
          stats.payments.push({ txId: req.params.txId, amount: tx.amount, phone: tx.phone, productId: tx.productId, date: new Date().toISOString() });
          writeJSON("stats", stats);

          return res.json({ status: "completed", verificationToken: vToken });
        }

        if (statusData.status === "failed") {
          tx.status = "failed";
          writeJSON("transactions", transactions);
          return res.json({ status: "failed" });
        }
      } catch (e) { console.error("Paynecta poll error:", e); }
    }

    res.json({ status: "pending" });
  } catch (err) {
    res.status(500).json({ error: "Status check failed" });
  }
});

app.post("/api/request-download", (req, res) => {
  const { verificationToken, productId } = req.body;
  if (!verificationToken || !productId) return res.status(400).json({ error: "Missing fields" });

  const transactions = readJSON("transactions", {});
  const tx = Object.values(transactions).find(
    (t) => t.verificationToken === verificationToken && t.productId === productId
  );
  if (!tx) return res.status(403).json({ error: "Invalid verification" });
  if (tx.vTokenExpiry && Date.now() > tx.vTokenExpiry) return res.status(403).json({ error: "Token expired" });

  const dlToken = crypto.randomBytes(16).toString("hex");
  tx.downloadToken = dlToken;
  tx.dlTokenExpiry = Date.now() + 2 * 60 * 1000;
  writeJSON("transactions", transactions);

  res.json({ downloadToken: dlToken });
});

app.get("/api/download/:token", (req, res) => {
  const transactions = readJSON("transactions", {});
  const tx = Object.values(transactions).find((t) => t.downloadToken === req.params.token);
  if (!tx) return res.status(403).json({ error: "Invalid download token" });
  if (tx.dlTokenExpiry && Date.now() > tx.dlTokenExpiry) return res.status(403).json({ error: "Token expired" });

  const products = readJSON("products", []);
  const product = products.find((p) => p.id === tx.productId);
  if (!product || !product.filePath) return res.status(404).json({ error: "File not found" });

  const fullPath = path.join(DATA_DIR, "uploads", product.filePath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File missing" });

  // Update download count
  product.downloads = (product.downloads || 0) + 1;
  writeJSON("products", products);

  const stats = readJSON("stats", {});
  stats.downloads = (stats.downloads || 0) + 1;
  writeJSON("stats", stats);

  // Delete download token (one-time use)
  delete tx.downloadToken;
  delete tx.dlTokenExpiry;
  writeJSON("transactions", transactions);

  const ext = path.extname(product.filePath).toLowerCase();
  const mime = ext === ".pdf" ? "application/pdf" : ext === ".docx"
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/octet-stream";

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${product.title.replace(/[^a-zA-Z0-9 ]/g, "")}${ext}"`);
  fs.createReadStream(fullPath).pipe(res);
});

// ─── ADMIN ROUTES ───

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  const settings = readJSON("settings", {});
  if (password !== settings.adminPassword) return res.status(401).json({ error: "Wrong password" });
  const token = Buffer.from(String(Date.now())).toString("base64");
  res.json({ token });
});

// Dashboard stats
app.get("/api/admin/stats", adminAuth, (req, res) => {
  const stats = readJSON("stats", {});
  const products = readJSON("products", []);
  const totalProducts = products.length;
  const totalDownloads = products.reduce((s, p) => s + (p.downloads || 0), 0);
  res.json({ ...stats, totalProducts, totalDownloads, downloads: totalDownloads });
});

// Visitors
app.get("/api/admin/visitors", adminAuth, (req, res) => {
  const visitors = readJSON("visitors", []);
  res.json(visitors.slice(-100).reverse());
});

// ── Products CRUD ──

app.get("/api/admin/products", adminAuth, (req, res) => {
  res.json(readJSON("products", []));
});

app.post("/api/admin/products", adminAuth, upload.fields([
  { name: "document", maxCount: 1 },
  { name: "cover", maxCount: 1 },
]), (req, res) => {
  const { title, grade, subject, term, weeks, price, pages } = req.body;
  if (!title || !grade || !subject || !term || !weeks || !price) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const products = readJSON("products", []);
  const id = crypto.randomBytes(8).toString("hex");
  const product = {
    id,
    title: title.trim(),
    grade,
    subject,
    term: parseInt(term),
    weeks: weeks.trim(),
    price: parseInt(price),
    pages: pages ? parseInt(pages) : null,
    visible: true,
    downloads: 0,
    createdAt: new Date().toISOString(),
    filePath: req.files?.document?.[0]?.filename || null,
    coverUrl: req.files?.cover?.[0]?.filename ? `/covers/${req.files.cover[0].filename}` : "",
  };
  products.push(product);
  writeJSON("products", products);
  res.json(product);
});

app.put("/api/admin/products/:id", adminAuth, upload.fields([
  { name: "document", maxCount: 1 },
  { name: "cover", maxCount: 1 },
]), (req, res) => {
  const products = readJSON("products", []);
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const { title, grade, subject, term, weeks, price, pages, visible } = req.body;
  if (title) products[idx].title = title.trim();
  if (grade) products[idx].grade = grade;
  if (subject) products[idx].subject = subject;
  if (term) products[idx].term = parseInt(term);
  if (weeks) products[idx].weeks = weeks.trim();
  if (price) products[idx].price = parseInt(price);
  if (pages !== undefined) products[idx].pages = pages ? parseInt(pages) : null;
  if (visible !== undefined) products[idx].visible = visible === "true" || visible === true;

  if (req.files?.document?.[0]) {
    // Remove old file
    if (products[idx].filePath) {
      const old = path.join(DATA_DIR, "uploads", products[idx].filePath);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    products[idx].filePath = req.files.document[0].filename;
  }
  if (req.files?.cover?.[0]) {
    products[idx].coverUrl = `/covers/${req.files.cover[0].filename}`;
  }

  writeJSON("products", products);
  res.json(products[idx]);
});

app.delete("/api/admin/products/:id", adminAuth, (req, res) => {
  let products = readJSON("products", []);
  const product = products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Not found" });

  // Clean up files
  if (product.filePath) {
    const fp = path.join(DATA_DIR, "uploads", product.filePath);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  if (product.coverUrl) {
    const cp = path.join(DATA_DIR, "covers", path.basename(product.coverUrl));
    if (fs.existsSync(cp)) fs.unlinkSync(cp);
  }

  products = products.filter((p) => p.id !== req.params.id);
  writeJSON("products", products);
  res.json({ ok: true });
});

// Toggle visibility
app.patch("/api/admin/products/:id/visibility", adminAuth, (req, res) => {
  const products = readJSON("products", []);
  const product = products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Not found" });
  product.visible = !product.visible;
  writeJSON("products", products);
  res.json(product);
});

// ── Subjects CRUD ──

app.get("/api/admin/subjects", adminAuth, (req, res) => {
  res.json(readJSON("subjects", []));
});

app.post("/api/admin/subjects", adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  const subjects = readJSON("subjects", []);
  if (subjects.includes(name.trim())) return res.status(400).json({ error: "Already exists" });
  subjects.push(name.trim());
  subjects.sort();
  writeJSON("subjects", subjects);
  res.json(subjects);
});

app.delete("/api/admin/subjects/:name", adminAuth, (req, res) => {
  let subjects = readJSON("subjects", []);
  subjects = subjects.filter((s) => s !== decodeURIComponent(req.params.name));
  writeJSON("subjects", subjects);
  res.json(subjects);
});

// ── Engagements ──

app.get("/api/admin/engagements", adminAuth, (req, res) => {
  res.json(readJSON("engagements", []));
});

app.post("/api/admin/engagements", adminAuth, (req, res) => {
  const { title, message, trigger, collectWhatsapp, active } = req.body;
  const engagements = readJSON("engagements", []);
  const id = crypto.randomBytes(6).toString("hex");
  engagements.push({ id, title, message, trigger: trigger || "page_load", collectWhatsapp: !!collectWhatsapp, active: active !== false, createdAt: new Date().toISOString() });
  writeJSON("engagements", engagements);
  res.json(engagements);
});

app.delete("/api/admin/engagements/:id", adminAuth, (req, res) => {
  let engagements = readJSON("engagements", []);
  engagements = engagements.filter((e) => e.id !== req.params.id);
  writeJSON("engagements", engagements);
  res.json(engagements);
});

app.patch("/api/admin/engagements/:id/toggle", adminAuth, (req, res) => {
  const engagements = readJSON("engagements", []);
  const e = engagements.find((x) => x.id === req.params.id);
  if (e) e.active = !e.active;
  writeJSON("engagements", engagements);
  res.json(engagements);
});

// ── Banner ──

app.get("/api/admin/banner", adminAuth, (req, res) => {
  const settings = readJSON("settings", {});
  res.json(settings.banner || { enabled: false, text: "" });
});

app.put("/api/admin/banner", adminAuth, (req, res) => {
  const settings = readJSON("settings", {});
  settings.banner = { ...settings.banner, ...req.body };
  writeJSON("settings", settings);
  res.json(settings.banner);
});

// ── Settings ──

app.get("/api/admin/settings", adminAuth, (req, res) => {
  const settings = readJSON("settings", {});
  const { adminPassword, ...safe } = settings;
  res.json(safe);
});

app.put("/api/admin/settings", adminAuth, (req, res) => {
  const settings = readJSON("settings", {});
  const { enabledTerms, defaultTerm } = req.body;
  if (enabledTerms) settings.enabledTerms = enabledTerms;
  if (defaultTerm) settings.defaultTerm = defaultTerm;
  writeJSON("settings", settings);
  res.json(settings);
});

app.post("/api/admin/change-password", adminAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const settings = readJSON("settings", {});
  if (currentPassword !== settings.adminPassword) return res.status(400).json({ error: "Current password incorrect" });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "Password too short" });
  settings.adminPassword = newPassword;
  writeJSON("settings", settings);
  res.json({ ok: true });
});

// Password reset via email
app.post("/api/admin/reset-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;
  if (!emailUser || !emailPass) return res.status(500).json({ error: "Email not configured" });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const settings = readJSON("settings", {});
  settings.resetCode = code;
  settings.resetExpiry = Date.now() + 15 * 60 * 1000;
  writeJSON("settings", settings);

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: emailUser, pass: emailPass },
    });
    await transporter.sendMail({
      from: emailUser,
      to: email,
      subject: "SchemeVault Admin Password Reset",
      text: `Your password reset code is: ${code}\n\nThis code expires in 15 minutes.`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

app.post("/api/admin/verify-reset", (req, res) => {
  const { code, newPassword } = req.body;
  const settings = readJSON("settings", {});
  if (!settings.resetCode || settings.resetCode !== code) return res.status(400).json({ error: "Invalid code" });
  if (Date.now() > settings.resetExpiry) return res.status(400).json({ error: "Code expired" });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "Password too short" });
  settings.adminPassword = newPassword;
  delete settings.resetCode;
  delete settings.resetExpiry;
  writeJSON("settings", settings);
  res.json({ ok: true });
});

// ── Backup & Restore ──

app.get("/api/admin/backup", adminAuth, (req, res) => {
  const archive = archiver("zip", { zlib: { level: 9 } });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=schemevault-backup-${Date.now()}.zip`);
  archive.pipe(res);
  archive.directory(DATA_DIR, false);
  archive.finalize();
});

app.post("/api/admin/restore", adminAuth, upload.single("backup"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  try {
    await extractZip(req.file.path, { dir: DATA_DIR });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    console.error("Restore error:", err);
    res.status(500).json({ error: "Restore failed" });
  }
});

// ── Payment history ──
app.get("/api/admin/payments", adminAuth, (req, res) => {
  const stats = readJSON("stats", {});
  res.json(stats.payments || []);
});

// Health check
app.get("/api/health", (req, res) => res.json({ status: "ok", demo: isDemoMode }));

app.listen(PORT, () => console.log(`SchemeVault server running on port ${PORT}${isDemoMode ? " (DEMO MODE)" : ""}`));
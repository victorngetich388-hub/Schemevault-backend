// ------------------------------
// Promotional Banner Settings
// ------------------------------
const BANNER_FILE = 'banner.json';

app.get('/api/banner', (req, res) => {
    const banner = readJSON(BANNER_FILE, { enabled: false, text: '', startDate: null, endDate: null });
    res.json(banner);
});

app.get('/api/admin/banner', isAdmin, (req, res) => {
    res.json(readJSON(BANNER_FILE, { enabled: false, text: '', startDate: null, endDate: null }));
});

app.post('/api/admin/banner', isAdmin, (req, res) => {
    const { enabled, text, startDate, endDate } = req.body;
    const banner = { enabled, text, startDate: startDate || null, endDate: endDate || null };
    writeJSON(BANNER_FILE, banner);
    res.json({ success: true });
});

// ------------------------------
// WhatsApp Button Settings
// ------------------------------
const WHATSAPP_FILE = 'whatsapp.json';

app.get('/api/admin/whatsapp', isAdmin, (req, res) => {
    res.json(readJSON(WHATSAPP_FILE, { enabled: false, phone: '', message: '' }));
});

app.post('/api/admin/whatsapp', isAdmin, (req, res) => {
    const { enabled, phone, message } = req.body;
    writeJSON(WHATSAPP_FILE, { enabled, phone, message });
    res.json({ success: true });
});
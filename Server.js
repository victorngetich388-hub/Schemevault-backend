const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===== REPLACE WITH YOUR REAL PAYNECTA CREDENTIALS =====
const PAYNECTA_API_URL = 'https://paynecta.co.ke/api/v1/payment/initialize';
const API_KEY = 'hmp_BN9eezffYAuSx3S5BLt3vRiOdvnMmgpiDePcYH8s'; // ⬅️ REPLACE with your full API key
const USER_EMAIL = 'victorngetich388@gmail.com';
const PAYMENT_CODE = 'PNT_266269';
// ========================================================

const transactions = new Map();

function generateTransactionId() {
    return 'TXN_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\s/g, '');
    if (cleaned.startsWith('0')) return '254' + cleaned.slice(1);
    if (cleaned.startsWith('+254')) return cleaned.slice(1);
    if (cleaned.startsWith('254')) return cleaned;
    return '254' + cleaned;
}

app.post('/api/initiate-payment', async (req, res) => {
    try {
        const { amount, phone, resourceId, resourceTitle } = req.body;
        const transactionId = generateTransactionId();
        const formattedPhone = formatPhoneNumber(phone);

        transactions.set(transactionId, { status: 'pending', resourceId, amount, phone: formattedPhone, resourceTitle });

        const payload = { code: PAYMENT_CODE, mobile_number: formattedPhone, amount: amount };

        const response = await axios.post(PAYNECTA_API_URL, payload, {
            headers: { 'X-API-Key': API_KEY, 'X-User-Email': USER_EMAIL, 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.success === true) {
            res.json({ success: true, transactionId, message: 'Payment initiated. Check your phone.' });
        } else {
            transactions.delete(transactionId);
            res.json({ success: false, message: response.data?.message || 'Payment initiation failed' });
        }
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: 'Payment gateway error' });
    }
});

app.post('/api/webhook', (req, res) => {
    const { transaction_reference, status } = req.body;
    if (transaction_reference && transactions.has(transaction_reference)) {
        const tx = transactions.get(transaction_reference);
        tx.status = status === 'completed' ? 'completed' : 'failed';
        transactions.set(transaction_reference, tx);
    }
    res.status(200).json({ status: 'received' });
});

app.get('/api/status/:transactionId', (req, res) => {
    const tx = transactions.get(req.params.transactionId);
    res.json(tx ? { status: tx.status } : { status: 'not_found' });
});

app.get('/', (req, res) => {
    res.json({ status: 'running', service: 'SchemeVault Backend' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

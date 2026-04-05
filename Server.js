const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'SchemeVault' });
});

app.get('/', (req, res) => {
    res.json({ status: 'running', service: 'SchemeVault Backend' });
});

// Initiate M-Pesa STK Push via Paynecta
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount } = req.body;

    // Validate
    if (!phone || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Phone number and valid amount required' });
    }

    // Clean phone number to 254 format (Paynecta requires 2547XXXXXXXX)
    let cleanPhone = phone.replace(/\s/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '254' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('+')) {
        cleanPhone = cleanPhone.substring(1);
    }

    try {
        const apiKey = process.env.PAYNECTA_API_KEY;
        const userEmail = process.env.PAYNECTA_EMAIL;
        const paymentCode = process.env.PAYNECTA_PAYMENT_CODE;
        const apiUrl = process.env.PAYNECTA_API_URL || 'https://api.paynecta.co.ke';

        if (!apiKey || !userEmail || !paymentCode) {
            console.error('Missing Paynecta credentials');
            return res.status(500).json({ success: false, error: 'Server payment configuration error' });
        }

        const payload = {
            code: paymentCode,
            mobile_number: cleanPhone,
            amount: amount
        };

        console.log('Initiating Paynecta payment:', payload);

        const response = await axios.post(`${apiUrl}/api/v1/payment/initialize`, payload, {
            headers: {
                'X-API-Key': apiKey,
                'X-User-Email': userEmail,
                'Content-Type': 'application/json'
            }
        });

        console.log('Paynecta response:', response.data);

        if (response.data.success) {
            const transactionId = response.data.data?.transaction_id || response.data.data?.id || Date.now().toString();
            res.json({ success: true, checkoutRequestId: transactionId });
        } else {
            res.status(400).json({ success: false, error: response.data.message || 'Payment initiation failed' });
        }

    } catch (error) {
        console.error('Paynecta error:', error.response?.data || error.message);
        const errorMsg = error.response?.data?.message || error.message || 'Payment initiation failed';
        res.status(500).json({ success: false, error: errorMsg });
    }
});

// Webhook for Paynecta to confirm payment
app.post('/api/payment-webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
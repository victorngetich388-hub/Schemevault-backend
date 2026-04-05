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
    const { phone, email, productId, amount } = req.body;

    // Validate
    if (!phone || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Phone number and valid amount required' });
    }

    // Clean phone number (remove any spaces, ensure starts with 254)
    let cleanPhone = phone.replace(/\s/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '254' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('+')) {
        cleanPhone = cleanPhone.substring(1);
    }

    try {
        // Use environment variables (must be set in Render)
        const paynectaUrl = process.env.PAYNECTA_API_URL || 'https://api.paynecta.co.ke/v1';
        const paymentCode = process.env.PAYNECTA_PAYMENT_CODE;
        const apiKey = process.env.PAYNECTA_API_KEY;

        if (!paymentCode || !apiKey) {
            console.error('Missing Paynecta credentials in environment');
            return res.status(500).json({ success: false, error: 'Server payment configuration error' });
        }

        const payload = {
            phoneNumber: cleanPhone,
            amount: amount,
            paymentCode: paymentCode,
            email: email || 'customer@schemevault.co.ke', // fallback email
            reference: `SCHEME_${productId || 'unknown'}_${Date.now()}`
        };

        console.log('Initiating Paynecta STK push:', payload);

        const response = await axios.post(`${paynectaUrl}/stkpush`, payload, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Paynecta response may have CheckoutRequestID or similar
        const checkoutRequestId = response.data.CheckoutRequestID || response.data.checkoutRequestId;
        if (!checkoutRequestId) {
            console.error('Unexpected Paynecta response:', response.data);
            return res.status(500).json({ success: false, error: 'Invalid response from payment gateway' });
        }

        res.json({ success: true, checkoutRequestId });

    } catch (error) {
        console.error('Paynecta error:', error.response?.data || error.message);
        const errorMsg = error.response?.data?.message || error.message || 'Payment initiation failed';
        res.status(500).json({ success: false, error: errorMsg });
    }
});

// Check payment status
app.get('/api/payment-status/:checkoutRequestId', async (req, res) => {
    const { checkoutRequestId } = req.params;
    const paynectaUrl = process.env.PAYNECTA_API_URL || 'https://api.paynecta.co.ke/v1';
    const apiKey = process.env.PAYNECTA_API_KEY;

    try {
        const response = await axios.get(`${paynectaUrl}/payment-status/${checkoutRequestId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Status check error:', error.message);
        res.status(500).json({ error: 'Unable to fetch payment status' });
    }
});

// Webhook (optional)
app.post('/api/payment-webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
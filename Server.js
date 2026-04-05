const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint (for uptime monitoring)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'SchemeVault Backend' });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ status: 'running', service: 'SchemeVault Backend' });
});

// ------------------------------
// Paynecta M-Pesa STK Push
// ------------------------------

// Initiate payment – sends STK push to customer's phone
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, email, productId, amount } = req.body;

    // Basic validation
    if (!phone || !email || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
    }

    try {
        const paynectaResponse = await axios.post(
            `${process.env.PAYNECTA_API_URL}/stkpush`,
            {
                phoneNumber: phone,
                amount: amount,
                paymentCode: process.env.PAYNECTA_PAYMENT_CODE,
                email: email,
                reference: `SCHEME_${productId}_${Date.now()}`
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.PAYNECTA_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Paynecta returns CheckoutRequestID
        const checkoutRequestId = paynectaResponse.data.CheckoutRequestID;
        res.json({ success: true, checkoutRequestId });
    } catch (error) {
        console.error('Paynecta error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Payment initiation failed' });
    }
});

// Check payment status (polled by frontend)
app.get('/api/payment-status/:checkoutRequestId', async (req, res) => {
    const { checkoutRequestId } = req.params;

    try {
        const response = await axios.get(
            `${process.env.PAYNECTA_API_URL}/payment-status/${checkoutRequestId}`,
            {
                headers: { 'Authorization': `Bearer ${process.env.PAYNECTA_API_KEY}` }
            }
        );
        res.json(response.data);
    } catch (error) {
        console.error('Status check error:', error.message);
        res.status(500).json({ error: 'Unable to fetch payment status' });
    }
});

// Webhook for Paynecta to confirm payment (optional but recommended)
app.post('/api/payment-webhook', async (req, res) => {
    const { CheckoutRequestID, ResultCode, amount, customerEmail, reference } = req.body;

    if (ResultCode === 0) {
        // Payment successful – you can save to database, send email, etc.
        console.log(`Payment successful: ${reference} for ${customerEmail}`);
        // TODO: Store that this email/product can download
        // You could also trigger an email with download link here
    } else {
        console.log(`Payment failed: ${reference}`);
    }
    res.sendStatus(200);
});

// Optional: endpoint to fetch available schemes (if you don't want static frontend data)
app.get('/api/products', (req, res) => {
    // In production, fetch from database
    const products = [
        { id: 1, title: "Mathematics Scheme of Work", grade: "Grade 4", term: 1, area: "Mathematics", price: 150, fileUrl: "https://your-storage.com/maths-term1.pdf" },
        // ... more products
    ];
    res.json(products);
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
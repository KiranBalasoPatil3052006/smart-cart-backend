const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const { generateCashierCode } = require('./verifyCode');

// Models
const Product = require('./models/Product');
const Customer = require('./models/customer');
const Purchase = require('./models/PurchaseHistory');

const CashIntent = require('./models/CashIntent');
const CashierCodeHistory = require('./models/CashierCodeHistory');

// Routes
const adminRoute = require('./routes/admin');

const app = express();
const PORT = 5000;

// CORS: allow requests from localhost and all ngrok domains (free or reserved)
app.use(
  cors({
    origin: [
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://localhost:5000',
      'http://127.0.0.1:5000',
      /https:\/\/.*\.ngrok-free\.app$/,
      /https:\/\/.*\.ngrok\.io$/
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  })
);

app.use(express.json());
app.use(bodyParser.json());

// Serve Cordova/frontend files if needed
app.use(express.static(path.join(__dirname, '../www')));

// MongoDB connection
mongoose
  .connect(' ', {
    useNewUrlParser: true,
    useUnifiedTopology: true
  })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB error:', err));

// Optional root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../www', 'CustomerLogin.html'));
});

/* === API ENDPOINTS === */

// Product by barcode
app.get('/product/:barcode', async (req, res) => {
  try {
    const product = await Product.findOne({ barcode: req.params.barcode });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// Add customer
app.post('/customer', async (req, res) => {
  const { name, mobile, email } = req.body;
  if (!name || !mobile || !email) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    await Customer.findOneAndUpdate(
      { mobile },
      { name, mobile, email },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: "Customer saved" });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Database error', error: err.message });
  }
});

// Get all customers
app.get('/customers', async (req, res) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 });
    res.json({ success: true, customers });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching customers', error: err.message });
  }
});

// Save purchase
app.post('/purchase', async (req, res) => {
  const { name, mobile, email, products, paymentMethod, cashierCode } = req.body;
  if (!name || !mobile || !products || !paymentMethod) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    const purchase = new Purchase({
      name,
      mobile,
      products,
      paymentMethod,
      cashierCode: paymentMethod === 'cash' ? cashierCode : null
    });

    if (paymentMethod === 'cash') {
      await CashIntent.deleteOne({ mobile });
    }

    await purchase.save();
    res.json({ success: true, message: 'Purchase saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error saving purchase', error: err.message });
  }
});

// Purchase history
app.get('/purchase-history', async (req, res) => {
  try {
    const history = await Purchase.find().sort({ date: -1 });
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching history', error: err.message });
  }
});

// Cash purchases
app.get('/purchases/cash', async (req, res) => {
  try {
    const cashPurchases = await Purchase.find({ paymentMethod: 'cash' }).sort({ date: -1 });
    res.json({ success: true, cashPurchases });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching cash purchases', error: err.message });
  }
});

// Online purchases
app.get('/purchases/online', async (req, res) => {
  try {
    const onlinePurchases = await Purchase.find({ paymentMethod: 'online' }).sort({ date: -1 });
    res.json({ success: true, onlinePurchases });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching online purchases', error: err.message });
  }
});

// Cash intent (generate cashier code)
app.post('/cash-intent', async (req, res) => {
  const { name, mobile } = req.body;
  if (!name || !mobile) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  const cashierCode = generateCashierCode();
  try {
    await CashIntent.findOneAndUpdate(
      { mobile },
      {
        name,
        mobile,
        cashierCode,
        date: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      },
      { upsert: true, new: true }
    );
    await CashierCodeHistory.create({ cashierCode, mobile });
    res.json({ success: true, cashierCode });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error saving cash intent', error: err.message });
  }
});

// Active cash intents
app.get('/cash-intents', async (req, res) => {
  try {
    const intents = await CashIntent.find().sort({ date: -1 });
    res.json({ success: true, intents });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching cash intents', error: err.message });
  }
});

// Verify cashier code
app.post('/verify-cashier-code', async (req, res) => {
  const { mobile, cashierCode } = req.body;
  if (!mobile || !cashierCode) {
    return res.status(400).json({ success: false, message: 'Missing mobile or code' });
  }
  try {
    const intent = await CashIntent.findOne({ mobile, cashierCode: String(cashierCode) });
    if (!intent) {
      return res.status(401).json({ success: false, message: '❌ Invalid code' });
    }
    if (new Date() > intent.expiresAt) {
      await CashIntent.deleteOne({ mobile });
      return res.status(401).json({ success: false, message: '❌ Code expired' });
    }
    await CashIntent.deleteOne({ mobile });

    // Update CashierCodeHistory to mark as verified
    await CashierCodeHistory.updateOne(
      { mobile, cashierCode: String(cashierCode), verified: false },
      { $set: { verified: true, verifiedAt: new Date() } }
    );

    res.json({ success: true, message: '✅ Code verified' });
  } catch (err) {
    res.status(500).json({ success: false, message: '❌ Server error', error: err.message });
  }
});

// Cashier code history
app.get('/cashier-code-history', async (req, res) => {
  try {
    const history = await CashierCodeHistory.find().sort({ createdAt: -1 });
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching code history', error: err.message });
  }
});

// Admin routes
app.use('/admin', adminRoute);

// Listen on all interfaces for both mobile and laptop access
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Local: http://127.0.0.1:${PORT}`);
  console.log("🌐 Ngrok and LAN supported (check your ngrok URL)");
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const requestLogger = require(path.join(__dirname, 'middleware', 'log'));

const app = express();

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) return next();
    return requestLogger(req, res, next);
});

app.get('/api-plantoday', (req, res) => {
    res.send('PlanToday Backend Running');
});

app.use('/api', require('./routes/authRoute'));
app.use('/api', require('./routes/homeRoute'));


app.listen(3000, '0.0.0.0', () => {
    console.log('Server PlanToday running');
});

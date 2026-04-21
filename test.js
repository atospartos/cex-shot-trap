// test-server.js — сохраните в корне проекта
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`\n✅ Тестовый сервер запущен: http://localhost:${PORT}`);
    console.log(`   Mobula API Key: ${process.env.MOBULA_API_KEY ? '✅' : '❌'}`);
});
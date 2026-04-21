// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', apiRoutes);
app.use(express.static(path.join(process.cwd(), 'charts/public')));

app.listen(config.PORT, () => {
    console.log(`\n✅ Сервер запущен: http://localhost:${config.PORT}`);
    console.log(`   Поддерживаемые таймфреймы: ${Object.keys(config.INTERVAL_CONFIG).join(', ')}`);
});
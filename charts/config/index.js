// config/index.js
require('dotenv').config();
const path = require('path');

module.exports = {
    PORT: process.env.PORT,
    MOBULA_API_KEY: process.env.MOBULA_API_KEY,
    
    MEXC_API_BASE: 'https://api.mexc.com',
    MOBULA_API_BASE: 'https://api.mobula.io/api/2',
    
    REQUEST_DELAY_MS: 500,
    TIME_SHIFT_STEPS: 5,
    SYNC_TOLERANCE: 1.0,
    
    INTERVAL_CONFIG: {
        '1m': { mexc: '1m', mobula: '1m', ms: 60 * 1000, candlesPerDay: 1440, maxDays: 2, maxQueries: 6 },
        '5m': { mexc: '5m', mobula: '5m', ms: 5 * 60 * 1000, candlesPerDay: 288, maxDays: 10, maxQueries: 6 },
        '15m': { mexc: '15m', mobula: '15m', ms: 15 * 60 * 1000, candlesPerDay: 96, maxDays: 20, maxQueries: 6 },
        '30m': { mexc: '30m', mobula: '30m', ms: 30 * 60 * 1000, candlesPerDay: 48, maxDays: 20, maxQueries: 6 }
    },
    
    TOKENS_FILE: path.join(process.cwd(), 'data/tokens/tokens.js'),
    TOKENS_DATA_FILE: path.join(process.cwd(), 'data/tokens/tokens_data.json'),
    CACHE_DIR: path.join(process.cwd(), 'data/cache')
};
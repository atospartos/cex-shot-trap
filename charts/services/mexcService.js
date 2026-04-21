

// // services/mexcService.js
const axios = require('axios');
const config = require('../config');

async function fetchMexcChunk(symbol, interval, startTime, endTime) {
    try {
        const url = new URL(`${config.MEXC_API_BASE}/api/v3/klines`);
        url.searchParams.append('symbol', symbol.toUpperCase());
        url.searchParams.append('interval', interval);
        url.searchParams.append('limit', '500');

        if (startTime) url.searchParams.append('startTime', startTime);
        if (endTime) url.searchParams.append('endTime', endTime);

        const response = await axios.get(url.toString(), { timeout: 15000 });
        if (!response.data || !Array.isArray(response.data)) return [];
        // В fetchMexcChunk, перед return:
        console.log(`📡 MEXC URL: ${url.toString()}`);
        console.log(`📡 MEXC ответ: ${response.data.length} свечей, первая:`, response.data[0]);
        return response.data.map(c => ({
            time: c[0],
            close: parseFloat(c[4])
        }));
    } catch (error) {
        if (error.response?.status === 404) return [];
        console.error(`❌ MEXC ошибка: ${error.message}`);
        return [];
    }
}

async function fetchAllMexc(symbol, interval, startTime, endTime, maxQueries) {
    console.log(`   🌐 MEXC запрос: ${symbol}`);

    const allCandles = [];
    let currentStart = startTime;
    let queries = 0;

    while (currentStart < endTime && queries < maxQueries) {
        const chunk = await fetchMexcChunk(symbol, interval, currentStart, endTime);
        if (chunk.length === 0) break;
        allCandles.push(...chunk);
        const lastTime = chunk[chunk.length - 1].time;
        if (lastTime === currentStart) break;
        currentStart = lastTime + 1;
        queries++;

        if (queries < maxQueries && currentStart < endTime) {
            await new Promise(resolve => setTimeout(resolve, config.REQUEST_DELAY_MS));
        }
    }

    const validCandles = allCandles.filter(c => c.close > 0);
    console.log(`   ✅ MEXC: ${validCandles.length} свечей`);
    console.log(`🔍 MEXC запрос: ${symbol} с ${new Date(startTime).toISOString()} по ${new Date(endTime).toISOString()}`);
    return validCandles;
}

async function fetchMexcRange(symbol, interval, startTime, endTime) {
    const intervalMs = config.INTERVAL_CONFIG[interval]?.ms || 300000;
    const candlesNeeded = Math.ceil((endTime - startTime) / intervalMs);
    const maxQueries = Math.ceil(candlesNeeded / 500) + 1;
    return await fetchAllMexc(symbol, interval, startTime, endTime, maxQueries);
}

function normalizeMexcSymbol(symbol) {
    const upper = symbol.toUpperCase();
    if (upper.endsWith('USDT')) return upper;
    return `${upper}USDT`;
}

async function checkSymbolExists(symbol) {
    try {
        const normalized = normalizeMexcSymbol(symbol);
        const url = `${config.MEXC_API_BASE}/api/v3/ticker/price?symbol=${normalized}`;
        const response = await axios.get(url, { timeout: 5000 });
        return { exists: true, symbol: normalized, price: response.data.price };
    } catch (error) {
        return { exists: false, symbol: null };
    }
}

module.exports = { fetchAllMexc, fetchMexcRange, normalizeMexcSymbol, checkSymbolExists };
// services/mobulaService.js
const axios = require('axios');
const config = require('../config');

async function fetchMobulaChunk(address, chainId, period, from, to) {
    try {
        const url = new URL(`${config.MOBULA_API_BASE}/token/ohlcv-history`);
        url.searchParams.append('address', address);
        url.searchParams.append('chainId', chainId);
        url.searchParams.append('period', period);
        url.searchParams.append('amount', 2000);
        url.searchParams.append('usd', 'true');
        url.searchParams.append('from', from);
        url.searchParams.append('to', to);
        
        const response = await axios.get(url.toString(), {
            headers: { 'Authorization': `Bearer ${config.MOBULA_API_KEY}` },
            timeout: 15000
        });
        
        const candles = response.data?.data || [];
        return candles.map(c => ({ time: c.t, close: c.c }));
    } catch (error) {
        if (error.response?.status === 404) return [];
        console.error(`❌ Mobula ошибка: ${error.message}`);
        return [];
    }
}

async function fetchMobulaRange(address, chainId, period, startTime, endTime) {
    console.log(`   🌐 Mobula запрос: ${address.slice(0, 15)}...`);
    const chunk = await fetchMobulaChunk(address, chainId, period, startTime, endTime);
    const validCandles = chunk.filter(c => c.close > 0);
    console.log(`   ✅ Mobula: ${validCandles.length} свечей`);
    return validCandles;
}

module.exports = { fetchMobulaRange };
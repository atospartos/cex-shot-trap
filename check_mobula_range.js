const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.MOBULA_API_KEY;
const ADDRESS = '0xf9902EdfCa4F49DcaEBC335C73aEbD82C79C2886';
const CHAIN_ID = 'evm:1';
const now = Date.now();
const dayAgo = now - 24 * 60 * 60 * 1000;

async function check() {
    console.log(`\n🔍 Mobula запрос за последние 24 часа (${new Date(dayAgo).toISOString()} - ${new Date(now).toISOString()})\n`);
    
    const url = `https://api.mobula.io/api/2/token/ohlcv-history?address=${ADDRESS}&chainId=${CHAIN_ID}&period=1m&amount=2000&from=${dayAgo}&usd=true`;
    
    const response = await axios.get(url, { 
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 30000
    });
    
    const data = response.data?.data || [];
    console.log(`✅ Получено свечей: ${data.length}`);
    
    if (data.length > 0) {
        console.log(`\n📅 Первая свеча в ответе: ${new Date(data[0].t).toISOString()}`);
        console.log(`📅 Последняя свеча в ответе: ${new Date(data[data.length-1].t).toISOString()}`);
        
        // Проверяем, есть ли свечи за последние 24 часа
        const recentCandles = data.filter(c => c.t >= dayAgo);
        console.log(`\n📊 Свечей за последние 24 часа: ${recentCandles.length}`);
        
        if (recentCandles.length === 0) {
            console.log(`\n❌ Mobula НЕ вернул данные за последние 24 часа!`);
            console.log(`   Самая свежая свеча: ${new Date(data[data.length-1].t).toISOString()}`);
            console.log(`   Запрошенный from: ${new Date(dayAgo).toISOString()}`);
        }
    }
}

check().catch(console.error);
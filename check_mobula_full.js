const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.MOBULA_API_KEY;
const ADDRESS = '0xf9902EdfCa4F49DcaEBC335C73aEbD82C79C2886';
const CHAIN_ID = 'evm:1';

async function check() {
    console.log('\n🔍 Mobula: 2000 свечей для ADO\n');
    
    const url = `https://api.mobula.io/api/2/token/ohlcv-history?address=${ADDRESS}&chainId=${CHAIN_ID}&period=1m&amount=2000&usd=true`;
    
    try {
        const response = await axios.get(url, { 
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            timeout: 30000
        });
        
        const data = response.data?.data || [];
        console.log(`✅ Получено свечей: ${data.length}`);
        
        if (data.length > 0) {
            const firstTime = data[0].t;
            const lastTime = data[data.length - 1].t;
            const timeSpan = (lastTime - firstTime) / (60 * 60 * 1000);
            
            console.log(`\n📅 Первая свеча: ${new Date(firstTime).toISOString()}`);
            console.log(`   timestamp: ${firstTime}`);
            console.log(`   цена: ${data[0].c}`);
            
            console.log(`\n📅 Последняя свеча: ${new Date(lastTime).toISOString()}`);
            console.log(`   timestamp: ${lastTime}`);
            console.log(`   цена: ${data[data.length - 1].c}`);
            
            console.log(`\n📊 Диапазон: ${timeSpan.toFixed(1)} часов (${(timeSpan/24).toFixed(1)} дней)`);
            
            // Вывод первых 5 и последних 5 timestamps
            console.log(`\n🕐 Первые 5 timestamps:`);
            data.slice(0, 5).forEach(c => console.log(`   ${c.t} → ${new Date(c.t).toISOString()}`));
            
            console.log(`\n🕐 Последние 5 timestamps:`);
            data.slice(-5).forEach(c => console.log(`   ${c.t} → ${new Date(c.t).toISOString()}`));
        }
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        if (error.response) {
            console.error('Статус:', error.response.status);
            console.error('Данные:', error.response.data);
        }
    }
}

check();
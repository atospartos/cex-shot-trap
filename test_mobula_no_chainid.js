const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.MOBULA_API_KEY;
const ADDRESS = '9AvytnUKsLxPxFHFqS6VLxaxt5p6BhYNr53SD2Chpump';

async function test() {
    console.log('\n🔍 Тест Mobula API: запрос без chainId\n');
    
    // 1. Запрос БЕЗ chainId
    console.log('1️⃣ Запрос без chainId:');
    try {
        const url1 = `https://api.mobula.io/api/2/token/ohlcv-history?address=${ADDRESS}&period=1m&amount=10&usd=true`;
        const res1 = await axios.get(url1, { 
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            timeout: 10000
        });
        console.log(`   ✅ Успех! Получено свечей: ${res1.data?.data?.length || 0}`);
        if (res1.data?.data?.length > 0) {
            console.log(`   Первая свеча: ${new Date(res1.data.data[0].t).toISOString()}`);
            console.log(`   Цена: ${res1.data.data[0].c}`);
        }
    } catch (error) {
        console.log(`   ❌ Ошибка: ${error.message}`);
        if (error.response) console.log(`   Статус: ${error.response.status}, Данные:`, error.response.data);
    }
    
    // 2. Запрос С chainId для сравнения
    console.log('\n2️⃣ Запрос с chainId=evm:1:');
    try {
        const url2 = `https://api.mobula.io/api/2/token/ohlcv-history?address=${ADDRESS}&chainId=evm:1&period=1m&amount=10&usd=true`;
        const res2 = await axios.get(url2, { 
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            timeout: 10000
        });
        console.log(`   ✅ Успех! Получено свечей: ${res2.data?.data?.length || 0}`);
        if (res2.data?.data?.length > 0) {
            console.log(`   Первая свеча: ${new Date(res2.data.data[0].t).toISOString()}`);
            console.log(`   Цена: ${res2.data.data[0].c}`);
        }
    } catch (error) {
        console.log(`   ❌ Ошибка: ${error.message}`);
    }
}

test();
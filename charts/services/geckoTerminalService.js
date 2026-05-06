// services/geckoTerminalService.js
const axios = require('axios');
const { sleep } = require('../utils/timeHelpers');

const BASE_URL = 'https://api.geckoterminal.com/api/v2';

// Маппинг chainId GeckoTerminal -> формат API
const CHAIN_MAPPING = {
    'solana:solana': 'solana',
    'evm:1': 'eth',
    'evm:56': 'bsc', 
    'evm:137': 'polygon',
    'evm:42161': 'arbitrum',
    'evm:10': 'optimism',
    'evm:8453': 'base',
    'evm:43114': 'avalanche'
};

async function fetchGeckoTerminalOHLCV(tokenAddress, chainId, timeframe = '5m', startTime, endTime) {
    const chain = CHAIN_MAPPING[chainId];
    if (!chain) {
        console.warn(`⚠️ Неподдерживаемая сеть для GeckoTerminal: ${chainId}`);
        return [];
    }
    
    const url = `${BASE_URL}/ohlcv/${chain}/${tokenAddress}`;
    const allCandles = [];
    let beforeTimestamp = null;
    let retries = 0;
    
    while (retries < 3) {
        try {
            const params = {
                timeframe: timeframe,
                limit: 1000,
                currency: 'usd'
            };
            
            if (beforeTimestamp) {
                params.before_timestamp = beforeTimestamp;
            }
            
            const response = await axios.get(url, { params, timeout: 10000 });
            
            if (!response.data?.data?.attributes?.ohlcv_list) {
                break;
            }
            
            const candles = response.data.data.attributes.ohlcv_list.map(candle => ({
                time: candle[0] * 1000, // конвертируем в миллисекунды
                open: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                low: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                volume: parseFloat(candle[5])
            }));
            
            // Фильтруем по временному диапазону
            const filtered = candles.filter(c => c.time >= startTime && c.time <= endTime);
            allCandles.push(...filtered);
            
            // Если получили меньше лимита или достигли начала диапазона
            if (candles.length < 1000 || candles[candles.length - 1].time <= startTime) {
                break;
            }
            
            // Для пагинации назад
            beforeTimestamp = Math.floor(candles[candles.length - 1].time / 1000);
            await sleep(500); // пауза между запросами
            
        } catch (error) {
            retries++;
            console.error(`❌ GeckoTerminal ошибка (попытка ${retries}/3):`, error.message);
            if (error.response?.status === 429) {
                await sleep(2000); // rate limit подождать
            } else {
                break;
            }
        }
    }
    
    // Сортируем по времени и убираем дубликаты
    const unique = Array.from(new Map(allCandles.map(c => [c.time, c])).values());
    unique.sort((a, b) => a.time - b.time);
    
    console.log(`   🌐 GeckoTerminal: получено ${unique.length} свечей`);
    return unique;
}

// Альтернативный метод: получение через pool адрес (если есть LP адрес)
async function fetchGeckoTerminalByPool(poolAddress, chain, timeframe = '5m', limit = 500) {
    const url = `${BASE_URL}/ohlcv/${chain}/${poolAddress}`;
    try {
        const response = await axios.get(url, {
            params: { timeframe, limit, currency: 'usd' }
        });
        
        return response.data.data.attributes.ohlcv_list.map(candle => ({
            time: candle[0] * 1000,
            close: parseFloat(candle[4])
        }));
    } catch (error) {
        console.error(`GeckoTerminal ошибка для пула ${poolAddress}:`, error.message);
        return [];
    }
}

module.exports = { fetchGeckoTerminalOHLCV, fetchGeckoTerminalByPool, CHAIN_MAPPING };
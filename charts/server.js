const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT;
const MOBULA_API_KEY = process.env.MOBULA_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const MEXC_API_BASE = 'https://api.mexc.com';
const MOBULA_API_BASE = 'https://api.mobula.io/api/2';

// Путь к файлу с токенами
const TOKENS_FILE = path.join(process.cwd(), 'data', 'tokens.js');

// Убедимся, что папка data существует
if (!fs.existsSync(path.join(process.cwd(), 'data'))) {
    fs.mkdirSync(path.join(process.cwd(), 'data'));
}

// Инициализируем файл токенов если не существует
if (!fs.existsSync(TOKENS_FILE)) {
    const defaultTokens = {
        tokens: [
            {
                symbol: "BONKUSDT",
                address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
                chainId: "solana:solana",
                interval: "5m",
                status: "pending",
                lastAnalysis: null,
                recommendation: null,
                verdict: null,
                createdAt: new Date().toISOString()
            }
        ],
        lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(defaultTokens, null, 2));
}

// Функции для работы с файлом токенов
function loadTokens() {
    try {
        const data = fs.readFileSync(TOKENS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Ошибка загрузки токенов:', error.message);
        return { tokens: [] };
    }
}

function saveTokens(tokensData) {
    try {
        tokensData.lastUpdated = new Date().toISOString();
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokensData, null, 2));
        return true;
    } catch (error) {
        console.error('Ошибка сохранения токенов:', error.message);
        return false;
    }
}

function updateTokenAnalysis(symbol, analysis, chartPointsCount) {
    const tokensData = loadTokens();
    const tokenIndex = tokensData.tokens.findIndex(t => t.symbol === symbol);
    
    if (tokenIndex !== -1) {
        tokensData.tokens[tokenIndex].lastAnalysis = new Date().toISOString();
        tokensData.tokens[tokenIndex].recommendation = analysis.recommendation;
        tokensData.tokens[tokenIndex].verdict = analysis.verdict;
        tokensData.tokens[tokenIndex].winrate = analysis.winrate;
        tokensData.tokens[tokenIndex].closingRate = analysis.closingRate;
        tokensData.tokens[tokenIndex].totalEvents = analysis.totalEvents;
        tokensData.tokens[tokenIndex].successfulEvents = analysis.successfulEvents;
        tokensData.tokens[tokenIndex].chartPoints = chartPointsCount;
        tokensData.tokens[tokenIndex].status = analysis.verdict.includes('ПОДХОДИТ') ? 'approved' : 'rejected';
        
        saveTokens(tokensData);
        console.log(`💾 Сохранён анализ для ${symbol}: ${analysis.verdict}`);
    }
}

// Конфигурация интервалов
const INTERVAL_CONFIG = {
    '1m': { mexc: '1m', mobula: '1m', ms: 60 * 1000, candlesPerDay: 1440, maxDays: 2, maxQueries: 6 },
    '5m': { mexc: '5m', mobula: '5m', ms: 5 * 60 * 1000, candlesPerDay: 288, maxDays: 10, maxQueries: 6 },
    '15m': { mexc: '15m', mobula: '15m', ms: 15 * 60 * 1000, candlesPerDay: 96, maxDays: 20, maxQueries: 6 },
    '30m': { mexc: '30m', mobula: '30m', ms: 30 * 60 * 1000, candlesPerDay: 48, maxDays: 20, maxQueries: 6 }
};

const REQUEST_DELAY_MS = 500;
const TIME_SHIFT_STEPS = 10;
const SYNC_TOLERANCE = 0.3;

function getConfig(interval) {
    const cfg = INTERVAL_CONFIG[interval];
    if (!cfg) throw new Error(`Unsupported interval: ${interval}`);
    return cfg;
}

function calculateActualDays(requestedDays, maxDays) {
    return Math.min(requestedDays, maxDays);
}

function calculateQueriesNeeded(actualDays, candlesPerDay) {
    const candlesNeeded = Math.ceil(actualDays * candlesPerDay);
    return Math.ceil(candlesNeeded / 500);
}

async function fetchMexcChunk(symbol, interval, startTime, endTime) {
    const url = new URL(`${MEXC_API_BASE}/api/v3/klines`);
    url.searchParams.append('symbol', symbol.toUpperCase());
    url.searchParams.append('interval', interval);
    url.searchParams.append('limit', 500);
    url.searchParams.append('startTime', startTime);
    url.searchParams.append('endTime', endTime);

    const response = await axios.get(url.toString(), { timeout: 15000 });
    const candles = response.data;
    if (!candles || !Array.isArray(candles)) return [];
    return candles.map(c => ({ time: c[0], close: parseFloat(c[4]) }));
}

async function fetchAllMexc(symbol, interval, startTime, endTime, maxQueries) {
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
            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
        }
    }
    return allCandles.filter(c => c.close > 0);
}

async function fetchMobulaChunk(address, chainId, period, from, to) {
    const url = new URL(`${MOBULA_API_BASE}/token/ohlcv-history`);
    url.searchParams.append('address', address);
    url.searchParams.append('chainId', chainId);
    url.searchParams.append('period', period);
    url.searchParams.append('amount', 500);
    url.searchParams.append('usd', 'true');
    url.searchParams.append('from', from);
    url.searchParams.append('to', to);
    const response = await axios.get(url.toString(), {
        headers: { 'Authorization': `Bearer ${MOBULA_API_KEY}` },
        timeout: 15000
    });
    const candles = response.data?.data || [];
    return candles.map(c => ({ time: c.t, close: c.c }));
}

async function fetchAllMobula(address, chainId, period, startTime, endTime, maxQueries) {
    const allCandles = [];
    let currentFrom = startTime;
    let queries = 0;
    while (currentFrom < endTime && queries < maxQueries) {
        const chunk = await fetchMobulaChunk(address, chainId, period, currentFrom, endTime);
        if (chunk.length === 0) break;
        allCandles.push(...chunk);
        const lastTime = chunk[chunk.length - 1].time;
        if (lastTime === currentFrom) break;
        currentFrom = lastTime + 1;
        queries++;
        if (queries < maxQueries && currentFrom < endTime) {
            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
        }
    }
    return allCandles.filter(c => c.close > 0);
}

function findBestTimeShift(mexcData, mobulaData, intervalMs, toleranceMs) {
    const stepMs = Math.floor(intervalMs / TIME_SHIFT_STEPS);
    let bestShift = 0;
    let bestMatches = 0;
    const mobulaMap = new Map(mobulaData.map(d => [d.time, d]));
    for (let shift = -intervalMs; shift <= intervalMs; shift += stepMs) {
        let matches = 0;
        for (const mexc of mexcData) {
            const shiftedTime = mexc.time + shift;
            const mobula = mobulaMap.get(shiftedTime);
            if (mobula) {
                const diff = Math.abs(mexc.close - mobula.close) / mobula.close;
                if (diff < 0.1) matches++;
            }
        }
        if (matches > bestMatches) {
            bestMatches = matches;
            bestShift = shift;
        }
    }
    return { shift: bestShift, matches: bestMatches };
}

function alignData(mexcData, mobulaData, shiftMs, toleranceMs) {
    const mobulaMap = new Map(mobulaData.map(d => [d.time, d]));
    const aligned = [];
    for (const mexc of mexcData) {
        const shiftedTime = mexc.time + shiftMs;
        const mobula = mobulaMap.get(shiftedTime);
        if (mobula) {
            const diff = Math.abs(shiftedTime - mobula.time);
            if (diff <= toleranceMs) {
                aligned.push({
                    time: mexc.time,
                    mexcPrice: mexc.close,
                    dexPrice: mobula.close
                });
            }
        }
    }
    return aligned.sort((a, b) => a.time - b.time);
}

function analyzeDrawdowns(data, drawdownThreshold) {
    if (data.length < 5) return null;
    
    const intervalMs = data[1]?.time - data[0]?.time;
    const intervalHours = intervalMs / (60 * 60 * 1000);
    const maxRecoveryCandles = Math.min(Math.floor(12 / intervalHours), data.length);
    const events = [];
    
    for (let i = 0; i < data.length - maxRecoveryCandles; i++) {
        const current = data[i];
        const drawdown = (current.dexPrice - current.mexcPrice) / current.dexPrice;
        
        if (drawdown >= drawdownThreshold) {
            const entryPrice = current.mexcPrice;
            const entryDexPrice = current.dexPrice;
            let recovered = null;
            for (let j = i + 1; j < Math.min(i + maxRecoveryCandles, data.length); j++) {
                const future = data[j];
                const priceRatio = future.mexcPrice / entryDexPrice;
                if (priceRatio >= 0.995) {
                    recovered = { time: future.time, price: future.mexcPrice, ratio: priceRatio };
                    break;
                }
            }
            
            if (recovered) {
                const grossProfit = (recovered.price - entryPrice) / entryPrice;
                const netProfit = grossProfit - 0.001;
                const isSuccessful = grossProfit > -0.002;
                events.push({
                    entryDrawdown: drawdown * 100,
                    recoveryHours: (recovered.time - current.time) / (60 * 60 * 1000),
                    grossProfitPercent: (grossProfit * 100).toFixed(2),
                    netProfitPercent: (netProfit * 100).toFixed(2),
                    successful: isSuccessful
                });
            } else {
                events.push({ entryDrawdown: drawdown * 100, successful: false });
            }
            
            const skipHours = events[events.length - 1]?.recoveryHours || 1;
            const skipCandles = Math.max(1, Math.floor(skipHours / intervalHours));
            i += skipCandles;
        }
    }
    
    const validEvents = events.filter(e => e.successful !== undefined);
    const successful = events.filter(e => e.successful === true);
    if (validEvents.length === 0) return null;
    
    const winrate = successful.length / validEvents.length;
    const closingRate = (successful.length / validEvents.length) * 100;
    const drawdowns = validEvents.map(e => e.entryDrawdown);
    const profits = successful.map(e => parseFloat(e.netProfitPercent));
    const recoveryTimes = successful.map(e => e.recoveryHours);
    
    const median = (arr) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    
    console.log(`\n   📊 ИТОГОВАЯ СТАТИСТИКА:`);
    console.log(`   Всего событий: ${validEvents.length}`);
    console.log(`   Успешных схождений: ${successful.length}`);
    console.log(`   Процент схождения спреда: ${closingRate.toFixed(1)}%`);
    
    return {
        totalEvents: validEvents.length,
        successfulEvents: successful.length,
        winrate: (winrate * 100).toFixed(1) + '%',
        closingRate: closingRate.toFixed(1) + '%',
        drawdownStats: {
            median: median(drawdowns).toFixed(2) + '%',
            min: Math.min(...drawdowns).toFixed(2) + '%',
            max: Math.max(...drawdowns).toFixed(2) + '%'
        },
        profitStats: {
            median: median(profits).toFixed(2) + '%',
            min: profits.length ? Math.min(...profits).toFixed(2) + '%' : '—',
            max: profits.length ? Math.max(...profits).toFixed(2) + '%' : '—'
        },
        recoveryStats: {
            median: median(recoveryTimes).toFixed(1) + 'ч',
            min: recoveryTimes.length ? Math.min(...recoveryTimes).toFixed(1) + 'ч' : '—',
            max: recoveryTimes.length ? Math.max(...recoveryTimes).toFixed(1) + 'ч' : '—'
        },
        recommendation: {
            entryDrawdownPercent: median(drawdowns).toFixed(1),
            takeProfitPercent: median(profits).toFixed(1),
            maxHoldHours: Math.ceil(median(recoveryTimes)) + 1,
            expectedWinrate: (winrate * 100).toFixed(0) + '%'
        },
        verdict: winrate > 0.55 ? '✅ ПОДХОДИТ' : (winrate > 0.45 ? '⚠️ ТРЕБУЕТ ОСТОРОЖНОСТИ' : '❌ НЕ ПОДХОДИТ')
    };
}

// ==================== API ЭНДПОИНТЫ ====================

// Получить список всех токенов
app.get('/api/tokens', (req, res) => {
    const tokensData = loadTokens();
    res.json({ success: true, tokens: tokensData.tokens, lastUpdated: tokensData.lastUpdated });
});

// Получить конкретный токен по символу
app.get('/api/tokens/:symbol', (req, res) => {
    const tokensData = loadTokens();
    const token = tokensData.tokens.find(t => t.symbol === req.params.symbol);
    if (!token) {
        return res.status(404).json({ success: false, error: 'Token not found' });
    }
    res.json({ success: true, token });
});

// Добавить новый токен
app.post('/api/tokens', (req, res) => {
    const { symbol, address, chainId, interval } = req.body;
    if (!symbol || !address) {
        return res.status(400).json({ success: false, error: 'symbol and address are required' });
    }
    
    const tokensData = loadTokens();
    if (tokensData.tokens.find(t => t.symbol === symbol)) {
        return res.status(400).json({ success: false, error: 'Token already exists' });
    }
    
    const newToken = {
        symbol: symbol.toUpperCase(),
        address,
        chainId: chainId || 'solana:solana',
        interval: interval || '5m',
        status: 'pending',
        lastAnalysis: null,
        recommendation: null,
        verdict: null,
        createdAt: new Date().toISOString()
    };
    
    tokensData.tokens.push(newToken);
    saveTokens(tokensData);
    res.json({ success: true, token: newToken });
});

// Удалить токен
app.delete('/api/tokens/:symbol', (req, res) => {
    const tokensData = loadTokens();
    const initialLength = tokensData.tokens.length;
    tokensData.tokens = tokensData.tokens.filter(t => t.symbol !== req.params.symbol);
    
    if (tokensData.tokens.length === initialLength) {
        return res.status(404).json({ success: false, error: 'Token not found' });
    }
    
    saveTokens(tokensData);
    res.json({ success: true });
});

// Анализ токена
app.post('/api/analyze', async (req, res) => {
    const { symbol, tokenAddress, chainId, interval, days = 3, drawdownThreshold = 0.015 } = req.body;
    
    if (!symbol || !tokenAddress) {
        return res.status(400).json({ success: false, error: 'symbol and tokenAddress are required' });
    }
    
    const cfg = getConfig(interval);
    const actualDays = calculateActualDays(days, cfg.maxDays);
    const queriesNeeded = calculateQueriesNeeded(actualDays, cfg.candlesPerDay);
    const warning = actualDays < days ? `Запрошено ${days} дней, загружено максимум ${actualDays} дней для таймфрейма ${interval}` : null;
    const endTime = Date.now();
    const startTime = endTime - (actualDays * 24 * 60 * 60 * 1000);
    
    console.log(`\n📊 Анализ: ${symbol} | ${interval} | ${actualDays} дней (${queriesNeeded} запросов)`);
    if (warning) console.log(`   ⚠️ ${warning}`);
    
    try {
        const [mexcRaw, mobulaRaw] = await Promise.all([
            fetchAllMexc(symbol, cfg.mexc, startTime, endTime, queriesNeeded),
            fetchAllMobula(tokenAddress, chainId, cfg.mobula, startTime, endTime, queriesNeeded)
        ]);
        
        console.log(`   MEXC: ${mexcRaw.length} свечей, Mobula: ${mobulaRaw.length} свечей`);
        if (mexcRaw.length === 0) return res.json({ success: false, error: `Нет данных MEXC для ${symbol}` });
        if (mobulaRaw.length === 0) return res.json({ success: false, error: `Нет данных Mobula для токена` });
        
        const toleranceMs = cfg.ms * SYNC_TOLERANCE;
        const { shift } = findBestTimeShift(mexcRaw, mobulaRaw, cfg.ms, toleranceMs);
        console.log(`   Найден сдвиг: ${shift} мс (${(shift / 1000).toFixed(1)} сек)`);
        
        const aligned = alignData(mexcRaw, mobulaRaw, shift, toleranceMs);
        console.log(`   Синхронизировано: ${aligned.length} точек`);
        if (aligned.length < 5) return res.json({ success: false, error: `Синхронизировано только ${aligned.length} точек` });
        
        const chartData = aligned.map(a => ({
            time: a.time,
            date: new Date(a.time).toLocaleString(),
            mexcPrice: a.mexcPrice,
            dexPrice: a.dexPrice,
            spread: ((a.mexcPrice - a.dexPrice) / a.dexPrice) * 100
        }));
        
        const analysis = analyzeDrawdowns(aligned, drawdownThreshold);
        
        // Сохраняем результаты анализа в файл токенов
        if (analysis && analysis.success !== false) {
            updateTokenAnalysis(symbol, analysis, chartData.length);
        }
        
        res.json({
            success: true,
            meta: {
                interval,
                requestedDays: days,
                actualDays,
                actualStart: new Date(startTime).toISOString(),
                actualEnd: new Date(endTime).toISOString(),
                mexcQueries: queriesNeeded,
                mobulaQueries: queriesNeeded,
                timeShiftMs: shift,
                warning
            },
            chart: { pointsCount: chartData.length, data: chartData },
            analysis: analysis || { error: 'Недостаточно данных для анализа просадок' }
        });
        
    } catch (error) {
        console.error(`❌ Ошибка:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        supportedIntervals: Object.keys(INTERVAL_CONFIG)
    });
});

app.listen(PORT, () => {
    console.log(`\n✅ Сервер запущен: http://localhost:${PORT}`);
    console.log(`   Поддерживаемые таймфреймы: ${Object.keys(INTERVAL_CONFIG).join(', ')}`);
    console.log(`   Файл токенов: ${TOKENS_FILE}`);
});
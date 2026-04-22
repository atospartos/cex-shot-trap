const express = require('express');
const router = express.Router();
const config = require('../config');
const { getConfig } = require('../utils/timeHelpers');
const { fetchAllMexc, normalizeMexcSymbol } = require('../services/mexcService');
const { fetchMobulaRange } = require('../services/mobulaService');
const { getAllTokensWithAnalysis, updateTokenAnalysis, loadTokens } = require('../services/tokenService');
const { findBestTimeShift, alignData, analyzeDrawdowns } = require('../analyzers/drawdownAnalyzer');

router.get('/tokens', (req, res) => {
    res.json({ success: true, tokens: loadTokens() });
});

router.get('/chains', (req, res) => {
    const chains = [
        { value: "solana:solana", name: "Solana", type: "solana" },
        { value: "evm:1", name: "Ethereum", type: "evm" },
        { value: "evm:56", name: "BNB Chain", type: "evm" },
        { value: "evm:137", name: "Polygon", type: "evm" },
        { value: "evm:42161", name: "Arbitrum", type: "evm" },
        { value: "evm:10", name: "Optimism", type: "evm" },
        { value: "evm:8453", name: "Base", type: "evm" }
    ];
    res.json({ success: true, chains });
});

router.post('/analyze', async (req, res) => {
    let { symbol, tokenAddress, chainId, interval, hours = 24, drawdownThreshold = 0.015 } = req.body;
    
    if (!symbol || !tokenAddress) {
        return res.status(400).json({ success: false, error: 'symbol and tokenAddress are required' });
    }
    
    const mexcSymbol = normalizeMexcSymbol(symbol);
    const cfg = getConfig(interval, config.INTERVAL_CONFIG);
    const intervalMs = cfg.ms;
    
    const MAX_CANDLES = 2000;
    let actualHours = hours;
    let timeSpan = actualHours * 60 * 60 * 1000;
    let calculatedCandles = Math.ceil(timeSpan / intervalMs);
    
    if (calculatedCandles > MAX_CANDLES) {
        actualHours = (MAX_CANDLES * intervalMs) / (60 * 60 * 1000);
        timeSpan = actualHours * 60 * 60 * 1000;
        calculatedCandles = MAX_CANDLES;
    }
    
    const now = Date.now();
    const startTime = now - timeSpan;
    const endTime = now;
    
    console.log(`\n📊 Анализ: ${symbol} -> ${mexcSymbol} | ${interval} | ${actualHours} часов (${calculatedCandles} свечей)`);
    console.log(`   Диапазон: ${new Date(startTime).toISOString().slice(0, 16)} - ${new Date(endTime).toISOString().slice(0, 16)}`);
    
    try {
        const mobulaRaw = await fetchMobulaRange(tokenAddress, chainId, cfg.mobula, startTime, endTime);
        if (!mobulaRaw || mobulaRaw.length === 0) {
            return res.json({ success: false, error: `Нет данных Mobula за указанный период` });
        }
        console.log(`   📊 Mobula: ${mobulaRaw.length} свечей`);
        
        const queriesNeeded = Math.min(Math.ceil(calculatedCandles / 500), 4);
        const mexcRaw = await fetchAllMexc(mexcSymbol, cfg.mexc, startTime, endTime, queriesNeeded);
        console.log(`   📊 MEXC: ${mexcRaw.length} свечей`);
        
        if (mexcRaw.length === 0) {
            return res.json({ success: false, error: `Нет данных MEXC для ${mexcSymbol}` });
        }
        
        const toleranceMs = cfg.ms * 1.5;
        const { shift } = findBestTimeShift(mexcRaw, mobulaRaw, cfg.ms, toleranceMs);
        console.log(`   Сдвиг: ${shift} мс (${(shift / 1000).toFixed(1)} сек)`);
        
        const aligned = alignData(mexcRaw, mobulaRaw, shift, toleranceMs);
        const syncPercent = mexcRaw.length > 0 ? (aligned.length / mexcRaw.length * 100).toFixed(1) : 0;
        console.log(`   Синхронизировано: ${aligned.length} точек (${syncPercent}%)`);
        
        const warnings = [];
        if (aligned.length < 10) {
            warnings.push(`Синхронизировано только ${aligned.length} точек (${syncPercent}%). Данных недостаточно для качественного анализа.`);
        }
        
        const chartData = aligned.map(a => ({
            time: a.time,
            date: new Date(a.time).toLocaleString(),
            mexcPrice: a.mexcPrice,
            dexPrice: a.dexPrice,
            spread: ((a.mexcPrice - a.dexPrice) / a.dexPrice) * 100
        }));
        
        let analysis = null;
        if (aligned.length >= 5) {
            analysis = analyzeDrawdowns(aligned, drawdownThreshold);
            if (analysis) updateTokenAnalysis(symbol, analysis, chartData.length);
        } else {
            analysis = { error: `Недостаточно данных для анализа просадок (${aligned.length} точек). Нужно минимум 5.` };
        }
        
        res.json({
            success: true,
            meta: {
                interval, requestedHours: hours, actualHours: actualHours.toFixed(1),
                mobulaPoints: mobulaRaw.length, mexcPoints: mexcRaw.length,
                syncedPoints: chartData.length, syncPercent: syncPercent,
                actualStart: new Date(startTime).toISOString(), actualEnd: new Date(endTime).toISOString(),
                timeShiftMs: shift, warnings: warnings
            },
            chart: { pointsCount: chartData.length, data: chartData },
            analysis: analysis || { error: 'Недостаточно данных для анализа просадок' }
        });
        
    } catch (error) {
        console.error(`❌ Ошибка:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
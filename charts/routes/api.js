const express = require('express');
const router = express.Router();
const config = require('../config');
const { getConfig } = require('../utils/timeHelpers');
const { fetchMexcRange, normalizeMexcSymbol } = require('../services/mexcService');
const { fetchMobulaRange } = require('../services/mobulaService');
const { getAllTokensWithAnalysis, updateTokenAnalysis, loadTokensFromJs } = require('../services/tokenService');
const { findBestTimeShift, alignData, analyzeDrawdowns } = require('../analyzers/drawdownAnalyzer');

router.get('/tokens', (req, res) => {
    res.json({ success: true, tokens: loadTokensFromJs() });
});

// ДОБАВИТЬ ЭНДПОИНТ /chains
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

// routes/api.js — эндпоинт /api/analyze
router.post('/analyze', async (req, res) => {
    let { 
        symbol, 
        tokenAddress, 
        chainId, 
        interval, 
        hours = null,
        days = null,
        drawdownThreshold = 0.015
    } = req.body;
    
    if (!symbol || !tokenAddress) {
        return res.status(400).json({ success: false, error: 'symbol and tokenAddress are required' });
    }
    
    const mexcSymbol = normalizeMexcSymbol(symbol);
    const cfg = getConfig(interval, config.INTERVAL_CONFIG);
    const intervalMs = cfg.ms;
    
    let startTime, endTime, requestedPeriod, requestedUnit, warning = null;
    const now = Date.now();
    
    // Приоритет: hours > days > значение по умолчанию (24 часа)
    if (hours && hours > 0) {
        const maxHours = cfg.maxDays * 24;
        let actualHours = Math.min(hours, maxHours);
        if (hours > maxHours) {
            warning = `Запрошено ${hours} часов, максимум ${maxHours} часов для ${interval}`;
        }
        const timeSpan = actualHours * 60 * 60 * 1000;
        endTime = now;
        startTime = endTime - timeSpan;
        
        const calculatedCandles = Math.ceil(timeSpan / intervalMs);
        console.log(`\n📊 Анализ: ${symbol} -> ${mexcSymbol} | ${interval} | ${actualHours} часов (${calculatedCandles} свечей)`);
        requestedPeriod = actualHours;
        requestedUnit = 'часов';
    } 
    else if (days && days > 0) {
        let actualDays = Math.min(days, cfg.maxDays);
        if (days > cfg.maxDays) {
            warning = `Запрошено ${days} дней, максимум ${cfg.maxDays} дней для ${interval}`;
        }
        const timeSpan = actualDays * 24 * 60 * 60 * 1000;
        endTime = now;
        startTime = endTime - timeSpan;
        
        const calculatedCandles = Math.ceil(actualDays * cfg.candlesPerDay);
        console.log(`\n📊 Анализ: ${symbol} -> ${mexcSymbol} | ${interval} | ${actualDays} дней (${calculatedCandles} свечей)`);
        requestedPeriod = actualDays;
        requestedUnit = 'дней';
    } 
    else {
        const defaultHours = 24;
        const maxHours = cfg.maxDays * 24;
        let actualHours = Math.min(defaultHours, maxHours);
        const timeSpan = actualHours * 60 * 60 * 1000;
        endTime = now;
        startTime = endTime - timeSpan;
        
        const calculatedCandles = Math.ceil(timeSpan / intervalMs);
        console.log(`\n📊 Анализ: ${symbol} -> ${mexcSymbol} | ${interval} | ${actualHours} часов (по умолчанию, ${calculatedCandles} свечей)`);
        requestedPeriod = actualHours;
        requestedUnit = 'часов';
    }
    
    if (warning) console.log(`   ⚠️ ${warning}`);
    
    try {
        // 1. Запрашиваем Mobula
        const mobulaRaw = await fetchMobulaRange(tokenAddress, chainId, cfg.mobula, startTime, endTime);
        
        if (!mobulaRaw || mobulaRaw.length === 0) {
            return res.json({ success: false, error: `Нет данных Mobula для токена` });
        }
        
        const mobulaMinTime = Math.min(...mobulaRaw.map(d => d.time));
        const mobulaMaxTime = Math.max(...mobulaRaw.map(d => d.time));
        const actualHoursLoaded = (mobulaMaxTime - mobulaMinTime) / (60 * 60 * 1000);
        
        console.log(`   📊 Mobula: ${mobulaRaw.length} свечей (${actualHoursLoaded.toFixed(1)} часов)`);
        
        // 2. Запрашиваем MEXC в том же диапазоне
        const mexcRaw = await fetchMexcRange(mexcSymbol, cfg.mexc, mobulaMinTime, mobulaMaxTime);
        
        console.log(`   📊 MEXC: ${mexcRaw.length} свечей`);
        
        if (mexcRaw.length === 0) {
            return res.json({ success: false, error: `Нет данных MEXC для ${mexcSymbol}` });
        }
        
        // 3. Синхронизация
        const toleranceMs = cfg.ms * config.SYNC_TOLERANCE;
        const { shift } = findBestTimeShift(mexcRaw, mobulaRaw, cfg.ms, toleranceMs);
        console.log(`   Сдвиг: ${shift} мс (${(shift / 1000).toFixed(1)} сек)`);
        
        const aligned = alignData(mexcRaw, mobulaRaw, shift, toleranceMs);
        console.log(`   Синхронизировано: ${aligned.length} точек (${((aligned.length/mexcRaw.length)*100).toFixed(1)}%)`);
        
        if (aligned.length < 5) {
            return res.json({ success: false, error: `Синхронизировано только ${aligned.length} точек` });
        }
        
        const chartData = aligned.map(a => ({
            time: a.time,
            date: new Date(a.time).toLocaleString(),
            mexcPrice: a.mexcPrice,
            dexPrice: a.dexPrice,
            spread: ((a.mexcPrice - a.dexPrice) / a.dexPrice) * 100
        }));
        
        const analysis = analyzeDrawdowns(aligned, drawdownThreshold);
        
        if (analysis) {
            updateTokenAnalysis(symbol, analysis, chartData.length);
        }
        
        res.json({
            success: true,
            meta: {
                interval,
                requestedPeriod: requestedPeriod,
                requestedUnit: requestedUnit,
                actualHoursLoaded: actualHoursLoaded.toFixed(1),
                actualCandles: chartData.length,
                actualStart: new Date(mobulaMinTime).toISOString(),
                actualEnd: new Date(mobulaMaxTime).toISOString(),
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

module.exports = router;
// analyzers/drawdownAnalyzer.js
const { median } = require('../utils/timeHelpers');

function findBestTimeShift(mexcData, mobulaData, intervalMs, toleranceMs, steps = 10) {
    const stepMs = Math.floor(intervalMs / steps);
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
                    recovered = { time: future.time, price: future.mexcPrice };
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
                    netProfitPercent: netProfit * 100,
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
    const profits = successful.map(e => e.netProfitPercent);
    const recoveryTimes = successful.map(e => e.recoveryHours);
    
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

module.exports = { findBestTimeShift, alignData, analyzeDrawdowns };
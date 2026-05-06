const fs = require('fs');
const path = require('path');
const config = require('../config');
// const { detectChainId } = require('../utils/chainDetector');

// ПРАВИЛЬНОЕ ОБЪЯВЛЕНИЕ ПЕРЕМЕННЫХ
const TOKENS_FILE = config.TOKENS_FILE;
const TOKENS_DATA_FILE = config.TOKENS_DATA_FILE;

// Функция нормализации chainId
function normalizeChainId(chainId) {
    if (!chainId) return null;
    
    const input = chainId.toString().toLowerCase().trim();
    
    // Маппинг различных форматов
    const mapping = {
        // Solana
        'solana': 'solana:solana',       
        // EVM сети
        'ethereum': 'evm:1',        
        'bsc': 'evm:56',        
        'polygon': 'evm:137',       
        'arbitrum': 'evm:42161',
        'optimism': 'evm:10',
        'base': 'evm:8453',
        'avalanche': 'evm:43114',
        // TON
        'ton': 'ton:ton',
        // Другие сети (пока без поддержки, но сохраняем)
        'xrpl': 'xrpl:xrpl',
        'algorand': 'algorand:algorand',
        'hyperevm': 'hyperevm:hyperevm'
    };
    
    if (mapping[input]) {
        return mapping[input];
    }
    
    console.warn(`⚠️ Неизвестный chainId: ${chainId}`);
    return chainId;
}

function loadTokens() {
    if (!fs.existsSync(TOKENS_FILE)) {
        throw new Error(`Файл ${TOKENS_FILE} не найден`);
    }
    const content = fs.readFileSync(TOKENS_FILE, 'utf8');
    const data = JSON.parse(content);
    let tokensList = [];
    
    if (Array.isArray(data)) {
        tokensList = data.map(item => ({
            symbol: item.symbol,
            address: item.address,
            chainId: normalizeChainId(item.chainId),  // ← нормализуем
            dexId: item.dexId,
            liquidityUSD: item.liquidityUSD,
            volume24hUSD: item.volume24hUSD,
            priceUSD: item.priceUSD,
            marketCapUSD: item.marketCapUSD
        }));
    } else {
        throw new Error(`Файл ${TOKENS_FILE} неверный формат`);
    }
    
    if (tokensList.length === 0) {
        throw new Error(`Файл ${TOKENS_FILE} не содержит токенов`);
    }
    return tokensList;
}


function loadAnalysisData() {
    try {
        if (fs.existsSync(TOKENS_DATA_FILE)) {
            const data = fs.readFileSync(TOKENS_DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Ошибка загрузки analysis data:', error.message);
    }
    return { tokens: [], lastUpdated: null };
}

function saveAnalysisData(analysisData) {
    try {
        analysisData.lastUpdated = new Date().toISOString();
        fs.writeFileSync(TOKENS_DATA_FILE, JSON.stringify(analysisData, null, 2));
        return true;
    } catch (error) {
        console.error('Ошибка сохранения analysis data:', error.message);
        return false;
    }
}

function getAllTokensWithAnalysis() {
    const rawTokens = loadTokensFromJs();
    const analysisData = loadAnalysisData();
    const analysisMap = new Map();

    for (const token of analysisData.tokens || []) {
        analysisMap.set(token.symbol, token);
    }

    // Возвращаем МАССИВ, а не объект
    const result = rawTokens.map(token => ({
        ...token,
        ...(analysisMap.get(token.symbol) || {}),
        status: analysisMap.get(token.symbol)?.status || 'pending',
        lastAnalysis: analysisMap.get(token.symbol)?.lastAnalysis || null,
        recommendation: analysisMap.get(token.symbol)?.recommendation || null,
        verdict: analysisMap.get(token.symbol)?.verdict || null,
        winrate: analysisMap.get(token.symbol)?.winrate || null,
        closingRate: analysisMap.get(token.symbol)?.closingRate || null
    }));

    console.log(`📋 Загружено токенов: ${result.length}`);  // отладка
    return result;  // ← МАССИВ
}

function updateTokenAnalysis(symbol, analysis, chartPointsCount) {
    const analysisData = loadAnalysisData();
    let tokensList = analysisData.tokens || [];

    const existingIndex = tokensList.findIndex(t => t.symbol === symbol);
    const tokenData = {
        symbol,
        lastAnalysis: new Date().toISOString(),
        recommendation: analysis.recommendation,
        verdict: analysis.verdict,
        winrate: analysis.winrate,
        closingRate: analysis.closingRate,
        totalEvents: analysis.totalEvents,
        successfulEvents: analysis.successfulEvents,
        chartPoints: chartPointsCount,
        status: analysis.verdict.includes('ПОДХОДИТ') ? 'approved' : 'rejected'
    };

    if (existingIndex !== -1) {
        tokensList[existingIndex] = { ...tokensList[existingIndex], ...tokenData };
    } else {
        tokensList.push(tokenData);
    }

    analysisData.tokens = tokensList;
    saveAnalysisData(analysisData);
    console.log(`💾 Сохранён анализ для ${symbol}: ${analysis.verdict}`);
}

module.exports = { getAllTokensWithAnalysis, updateTokenAnalysis, loadTokens };
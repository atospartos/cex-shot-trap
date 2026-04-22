const fs = require('fs');
const path = require('path');
const config = require('../config');
const { detectChainId } = require('../utils/chainDetector');

// ПРАВИЛЬНОЕ ОБЪЯВЛЕНИЕ ПЕРЕМЕННЫХ
const TOKENS_FILE = config.TOKENS_FILE;
const TOKENS_DATA_FILE = config.TOKENS_DATA_FILE;

function loadTokensFromJs() {
    try {
        const content = fs.readFileSync(TOKENS_FILE, 'utf8');
        const lines = content.split('\n');
        const tokens = [];

        for (const line of lines) {
            const symbolMatch = line.match(/symbol:\s*"([^"]+)"/);
            const addressMatch = line.match(/address:\s*"([^"]+)"/);

            if (symbolMatch && addressMatch) {
                tokens.push({
                    symbol: symbolMatch[1],
                    address: addressMatch[1],
                    chainId: 'solana:solana' // временно
                });
            }
        }

        console.log(`📁 Из файла загружено ${tokens.length} токенов`);
        return tokens;  // ← МАССИВ
    } catch (error) {
        console.error('Ошибка загрузки tokens.js:', error.message);
        return [];  // ← ПУСТОЙ МАССИВ, а не объект
    }
}

function loadTokens() {

    if (!fs.existsSync(TOKENS_FILE)) {
        throw new Error(`Файл ${TOKENS_FILE} не найден`);
    }

    const content = fs.readFileSync(TOKENS_FILE, 'utf8');
    const data = JSON.parse(content);
    let tokensList = [];
    if (data.tokens && Array.isArray(data.tokens)) {
        tokensList = data.tokens.map(item => ({
            symbol: item.symbol,
            address: item.address,
            chainId: item.chainId || null
        }));
    } else {
        throw new Error(`Файл ${TOKENS_FILE} неверный формат`);
    }

    console.log(`📖 Прочитано ${tokensList.length} токенов из ${TOKENS_FILE}`);

    if (tokensList.length === 0) {
        throw new Error(`Файл ${TOKENS_FILE} не содержит токенов`);
    }
    // console.log(`${data}`);
    return tokensList;
}

// console.error('Ошибка загрузки TOKENS_FILE data:', error.message);

// return { tokens: [], lastUpdated: null };


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

module.exports = { getAllTokensWithAnalysis, updateTokenAnalysis, loadTokensFromJs, loadTokens };
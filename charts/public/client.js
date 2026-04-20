const symbolInput = document.getElementById('symbol');
const tokenAddressInput = document.getElementById('tokenAddress');
const chainIdSelect = document.getElementById('chainId');
const intervalSelect = document.getElementById('interval');
const daysInput = document.getElementById('days');
const drawdownThresholdInput = document.getElementById('drawdownThreshold');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusDiv = document.getElementById('status');
const resultsPanel = document.getElementById('resultsPanel');

// Элементы навигации
const tokenSelect = document.getElementById('tokenSelect');
const prevTokenBtn = document.getElementById('prevTokenBtn');
const nextTokenBtn = document.getElementById('nextTokenBtn');
const refreshTokensBtn = document.getElementById('refreshTokensBtn');
const tokenStatusSpan = document.getElementById('tokenStatus');

let chartInstance = null;
let currentTokens = [];
let currentIndex = -1;

function setStatus(message, isError = false, isWarning = false, isSuccess = false) {
    statusDiv.textContent = message;
    if (isError) statusDiv.className = 'status-bar error';
    else if (isWarning) statusDiv.className = 'status-bar warning';
    else if (isSuccess) statusDiv.className = 'status-bar success';
    else statusDiv.className = 'status-bar';
}

function updateTokenStatus(token) {
    if (token) {
        const statusClass = token.status === 'approved' ? 'approved' : (token.status === 'rejected' ? 'rejected' : 'pending');
        const statusText = token.status === 'approved' ? '✅ ПОДХОДИТ' : (token.status === 'rejected' ? '❌ НЕ ПОДХОДИТ' : '⏳ ОЖИДАЕТ');
        tokenStatusSpan.className = `token-status ${statusClass}`;
        tokenStatusSpan.innerHTML = `${statusText} | WR: ${token.winrate || '—'}`;
    } else {
        tokenStatusSpan.className = 'token-status pending';
        tokenStatusSpan.innerHTML = 'статус: —';
    }
}

function loadTokenToForm(token) {
    if (!token) return;
    
    symbolInput.value = token.symbol;
    tokenAddressInput.value = token.address;
    chainIdSelect.value = token.chainId || 'solana:solana';
    intervalSelect.value = token.interval || '5m';
    
    updateTokenStatus(token);
    
    // Если есть сохранённый анализ, отображаем его
    if (token.recommendation) {
        displaySavedAnalysis(token);
    } else {
        resultsPanel.style.display = 'none';
    }
}

function displaySavedAnalysis(token) {
    if (!token.recommendation) return;
    
    resultsPanel.style.display = 'block';
    
    const winrateNum = parseFloat(token.winrate || 0);
    const winrateColor = winrateNum > 55 ? '#22c55e' : (winrateNum > 45 ? '#f59e0b' : '#ef4444');
    
    document.getElementById('winrate').innerHTML = `<span style="color: ${winrateColor}">${token.winrate || '—'}</span>`;
    document.getElementById('totalEvents').innerText = token.totalEvents || '—';
    document.getElementById('successfulEvents').innerText = token.successfulEvents || '—';
    document.getElementById('closingRate').innerHTML = token.closingRate || '—';
    document.getElementById('verdict').innerHTML = token.verdict || '—';
    
    document.getElementById('recEntry').innerHTML = `<strong>${token.recommendation.entryDrawdownPercent || '—'}%</strong>`;
    document.getElementById('recTP').innerHTML = `<strong>${token.recommendation.takeProfitPercent || '—'}%</strong>`;
    document.getElementById('recMaxHold').innerHTML = `<strong>${token.recommendation.maxHoldHours || '—'} ч</strong>`;
    document.getElementById('recWinrate').innerHTML = `<strong>${token.recommendation.expectedWinrate || '—'}</strong>`;
}

async function loadTokensList() {
    try {
        const response = await fetch('/api/tokens');
        const result = await response.json();
        
        if (result.success) {
            currentTokens = result.tokens;
            tokenSelect.innerHTML = '<option value="">-- Выберите токен --</option>';
            
            currentTokens.forEach((token, idx) => {
                const option = document.createElement('option');
                option.value = idx;
                const statusEmoji = token.status === 'approved' ? '✅' : (token.status === 'rejected' ? '❌' : '⏳');
                option.textContent = `${statusEmoji} ${token.symbol} | WR: ${token.winrate || '—'} | ${token.verdict || 'pending'}`;
                tokenSelect.appendChild(option);
            });
            
            setStatus(`✅ Загружено ${currentTokens.length} токенов`, false, false, true);
        }
    } catch (error) {
        console.error('Ошибка загрузки токенов:', error);
        setStatus('❌ Ошибка загрузки списка токенов', true);
    }
}

function selectTokenByIndex(index) {
    if (index >= 0 && index < currentTokens.length) {
        currentIndex = index;
        tokenSelect.value = index;
        loadTokenToForm(currentTokens[currentIndex]);
    }
}

function renderChart(data) {
    const canvas = document.getElementById('spreadChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    if (chartInstance) chartInstance.destroy();
    if (!data || data.length === 0) return;
    
    const labels = data.map(row => new Date(row.time).toLocaleString());
    const mexcPrices = data.map(row => row.mexcPrice);
    const dexPrices = data.map(row => row.dexPrice);
    const spreads = data.map(row => row.spread);
    
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: `MEXC ${symbolInput.value}`,
                    data: mexcPrices,
                    borderColor: '#3b82f6',
                    borderWidth: 2,
                    tension: 0.1,
                    pointRadius: 1,
                    yAxisID: 'y'
                },
                {
                    label: 'DEX (оракул)',
                    data: dexPrices,
                    borderColor: '#10b981',
                    borderWidth: 2,
                    tension: 0.1,
                    pointRadius: 1,
                    yAxisID: 'y'
                },
                {
                    label: 'Спред (%)',
                    data: spreads,
                    type: 'bar',
                    backgroundColor: 'rgba(239, 68, 68, 0.5)',
                    yAxisID: 'y1',
                    barPercentage: 0.8
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            plugins: { tooltip: { mode: 'index', intersect: false } },
            scales: {
                y: { title: { display: true, text: 'Цена (USD)' } },
                y1: { title: { display: true, text: 'Спред (%)' }, position: 'right' }
            }
        }
    });
}

function displayAnalysis(analysis) {
    if (!analysis || analysis.error) {
        resultsPanel.style.display = 'none';
        return;
    }
    
    resultsPanel.style.display = 'block';
    
    const winrateNum = parseFloat(analysis.winrate);
    const winrateColor = winrateNum > 55 ? '#22c55e' : (winrateNum > 45 ? '#f59e0b' : '#ef4444');
    
    document.getElementById('winrate').innerHTML = `<span style="color: ${winrateColor}">${analysis.winrate}</span>`;
    document.getElementById('totalEvents').innerText = analysis.totalEvents;
    document.getElementById('successfulEvents').innerText = analysis.successfulEvents;
    document.getElementById('closingRate').innerHTML = analysis.closingRate || '—';
    document.getElementById('verdict').innerHTML = analysis.verdict;
    
    document.getElementById('recEntry').innerHTML = `<strong>${analysis.recommendation.entryDrawdownPercent}%</strong>`;
    document.getElementById('recTP').innerHTML = `<strong>${analysis.recommendation.takeProfitPercent}%</strong>`;
    document.getElementById('recMaxHold').innerHTML = `<strong>${analysis.recommendation.maxHoldHours} ч</strong>`;
    document.getElementById('recWinrate').innerHTML = `<strong>${analysis.recommendation.expectedWinrate}</strong>`;
}

async function runAnalysis() {
    const symbol = symbolInput.value.trim().toUpperCase();
    const tokenAddress = tokenAddressInput.value.trim();
    const chainId = chainIdSelect.value;
    const interval = intervalSelect.value;
    const days = parseInt(daysInput.value, 10);
    const drawdownThreshold = parseFloat(drawdownThresholdInput.value) / 100;
    
    if (!symbol || !tokenAddress) {
        setStatus('❌ Заполните символ и адрес токена', true);
        return;
    }
    
    analyzeBtn.disabled = true;
    analyzeBtn.innerText = '⏳ Загрузка и анализ...';
    setStatus('🔄 Загрузка данных...');
    resultsPanel.style.display = 'none';
    
    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, tokenAddress, chainId, interval, days, drawdownThreshold })
        });
        
        const result = await response.json();
        
        if (!result.success) throw new Error(result.error);
        
        if (result.meta.warning) {
            setStatus(`⚠️ ${result.meta.warning}`, false, true);
        } else {
            setStatus(`✅ Данные загружены: ${result.meta.actualDays} дней, ${result.chart.pointsCount} точек`, false, false, true);
        }
        
        renderChart(result.chart.data);
        displayAnalysis(result.analysis);
        
        // Обновляем список токенов после сохранения анализа
        await loadTokensList();
        
        // Находим обновлённый токен в списке
        const updatedToken = currentTokens.find(t => t.symbol === symbol);
        if (updatedToken) {
            const newIndex = currentTokens.findIndex(t => t.symbol === symbol);
            if (newIndex !== -1) {
                currentIndex = newIndex;
                tokenSelect.value = newIndex;
                updateTokenStatus(updatedToken);
            }
        }
        
    } catch (err) {
        setStatus(`❌ ${err.message}`, true);
        resultsPanel.style.display = 'none';
    } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.innerText = '🔍 ЗАГРУЗИТЬ И АНАЛИЗИРОВАТЬ';
    }
}

// Обработчики навигации
tokenSelect.addEventListener('change', (e) => {
    const idx = parseInt(e.target.value);
    if (!isNaN(idx) && idx >= 0 && idx < currentTokens.length) {
        currentIndex = idx;
        loadTokenToForm(currentTokens[currentIndex]);
    }
});

prevTokenBtn.addEventListener('click', () => {
    if (currentTokens.length > 0) {
        const newIndex = currentIndex - 1;
        if (newIndex >= 0) {
            selectTokenByIndex(newIndex);
        } else {
            setStatus('⚠️ Это первый токен в списке', false, true);
        }
    }
});

nextTokenBtn.addEventListener('click', () => {
    if (currentTokens.length > 0) {
        const newIndex = currentIndex + 1;
        if (newIndex < currentTokens.length) {
            selectTokenByIndex(newIndex);
        } else {
            setStatus('⚠️ Это последний токен в списке', false, true);
        }
    }
});

refreshTokensBtn.addEventListener('click', () => {
    loadTokensList();
    setStatus('🔄 Список токенов обновлён', false, false, true);
});

analyzeBtn.addEventListener('click', runAnalysis);

// Загрузка списка токенов при старте
loadTokensList();
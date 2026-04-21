document.addEventListener('DOMContentLoaded', function() {
    console.log('✅ DOM загружен, инициализация...');

    const symbolInput = document.getElementById('symbol');
    const tokenAddressInput = document.getElementById('tokenAddress');
    const chainIdSelect = document.getElementById('chainId');
    const intervalSelect = document.getElementById('interval');
    const daysInput = document.getElementById('days');
    const hoursInput = document.getElementById('hours');
    const periodModeSelect = document.getElementById('periodMode');
    const drawdownThresholdInput = document.getElementById('drawdownThreshold');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const statusDiv = document.getElementById('status');
    const warningsDiv = document.getElementById('warnings');
    const syncInfoDiv = document.getElementById('syncInfo');
    const resultsPanel = document.getElementById('resultsPanel');
    const tokenSelect = document.getElementById('tokenSelect');
    const refreshTokensBtn = document.getElementById('refreshTokensBtn');
    const clearCacheBtn = document.getElementById('clearCacheBtn');
    const resetZoomBtn = document.getElementById('resetZoomBtn');

    let chartInstance = null;
    let currentTokens = [];

    function setStatus(message, isError = false, isSuccess = false, isWarning = false) {
        statusDiv.textContent = message;
        if (isError) statusDiv.className = 'status-bar error';
        else if (isSuccess) statusDiv.className = 'status-bar success';
        else if (isWarning) statusDiv.className = 'status-bar warning';
        else statusDiv.className = 'status-bar';
    }

    function showWarnings(warnings) {
        if (warnings && warnings.length > 0) {
            warningsDiv.innerHTML = warnings.map(w => `⚠️ ${w}`).join('<br>');
            warningsDiv.style.display = 'block';
        } else {
            warningsDiv.style.display = 'none';
        }
    }

    function showSyncInfo(meta) {
        if (syncInfoDiv) {
            syncInfoDiv.innerHTML = `📊 Синхронизировано: ${meta.syncedPoints} из ${meta.mexcPoints} точек MEXC (${meta.syncPercent}%) | Mobula: ${meta.mobulaPoints} свечей`;
        }
    }

    async function loadTokensList() {
        try {
            const response = await fetch('/api/tokens');
            const result = await response.json();
            if (result.success && Array.isArray(result.tokens)) {
                currentTokens = result.tokens;
                tokenSelect.innerHTML = '<option value="">-- Выберите токен --</option>';
                currentTokens.forEach((token, idx) => {
                    const option = document.createElement('option');
                    option.value = idx;
                    const statusEmoji = token.status === 'approved' ? '✅' : (token.status === 'rejected' ? '❌' : '⏳');
                    option.textContent = `${statusEmoji} ${token.symbol} | WR: ${token.winrate || '—'}`;
                    tokenSelect.appendChild(option);
                });
                setStatus(`✅ Загружено ${currentTokens.length} токенов`, false, true);
            }
        } catch (error) {
            setStatus('❌ Ошибка загрузки списка токенов', true);
        }
    }

    async function loadChains() {
        try {
            const response = await fetch('/api/chains');
            const result = await response.json();
            if (result.success && result.chains) {
                chainIdSelect.innerHTML = '<option value="">-- Выберите сеть --</option>';
                result.chains.forEach(chain => {
                    const option = document.createElement('option');
                    option.value = chain.value;
                    option.textContent = chain.name;
                    chainIdSelect.appendChild(option);
                });
                chainIdSelect.value = 'solana:solana';
            }
        } catch (error) {
            console.error('Ошибка загрузки сетей:', error);
        }
    }

    function loadTokenToForm(token) {
        if (!token) return;
        symbolInput.value = token.symbol;
        tokenAddressInput.value = token.address;
        chainIdSelect.value = token.chainId || 'solana:solana';
        if (token.recommendation) {
            resultsPanel.style.display = 'block';
            document.getElementById('winrate').innerHTML = token.winrate || '—';
            document.getElementById('totalEvents').innerText = token.totalEvents || '—';
            document.getElementById('successfulEvents').innerText = token.successfulEvents || '—';
            document.getElementById('closingRate').innerHTML = token.closingRate || '—';
            document.getElementById('verdict').innerHTML = token.verdict || '—';
            document.getElementById('recEntry').innerHTML = `<strong>${token.recommendation.entryDrawdownPercent || '—'}%</strong>`;
            document.getElementById('recTP').innerHTML = `<strong>${token.recommendation.takeProfitPercent || '—'}%</strong>`;
            document.getElementById('recMaxHold').innerHTML = `<strong>${token.recommendation.maxHoldHours || '—'} ч</strong>`;
            document.getElementById('recWinrate').innerHTML = `<strong>${token.recommendation.expectedWinrate || '—'}</strong>`;
        } else {
            resultsPanel.style.display = 'none';
        }
    }

    tokenSelect.addEventListener('change', (e) => {
        const idx = parseInt(e.target.value);
        if (!isNaN(idx) && currentTokens[idx]) loadTokenToForm(currentTokens[idx]);
    });

    refreshTokensBtn.addEventListener('click', loadTokensList);
    clearCacheBtn.addEventListener('click', async () => {
        await fetch('/api/cache/clear', { method: 'POST' });
        setStatus('🗑️ Кеш очищен', false, true);
    });

    function renderChart(data) {
        const canvas = document.getElementById('spreadChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (chartInstance) chartInstance.destroy();
        if (!data || data.length === 0) {
            setStatus('⚠️ Нет данных для отображения графика', false, false, true);
            return;
        }

        const labels = data.map(row => new Date(row.time).toLocaleString());
        const mexcPrices = data.map(row => row.mexcPrice);
        const dexPrices = data.map(row => row.dexPrice);
        const spreads = data.map(row => row.spread);

        chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    { label: `MEXC ${symbolInput.value}`, data: mexcPrices, borderColor: '#3b82f6', borderWidth: 2, tension: 0.1, pointRadius: 3, pointHoverRadius: 6, fill: false, yAxisID: 'y' },
                    { label: 'DEX (оракул)', data: dexPrices, borderColor: '#10b981', borderWidth: 2, tension: 0.1, pointRadius: 3, pointHoverRadius: 6, fill: false, yAxisID: 'y' },
                    { label: 'Спред (%)', data: spreads, type: 'bar', backgroundColor: 'rgba(239,68,68,0.6)', borderColor: 'rgba(239,68,68,1)', borderWidth: 1, yAxisID: 'y1', barPercentage: 0.8, categoryPercentage: 0.9 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                let value = context.raw;
                                if (context.dataset.label.includes('Спред')) {
                                    return `${label}: ${value.toFixed(2)}%`;
                                }
                                return `${label}: $${value.toFixed(8)}`;
                            }
                        }
                    },
                    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 10 } },
                    zoom: {
                        zoom: { wheel: { enabled: true, speed: 0.1 }, pinch: { enabled: true }, drag: { enabled: true }, mode: 'xy' },
                        pan: { enabled: true, mode: 'xy', speed: 10 },
                        limits: { x: { min: 'original', max: 'original' }, y: { min: 'original', max: 'original' } }
                    }
                },
                scales: {
                    y: { title: { display: true, text: 'Цена (USD)', color: '#1e293b' }, position: 'left', ticks: { callback: (val) => '$' + val.toExponential(4), maxTicksLimit: 8 } },
                    y1: { title: { display: true, text: 'Спред (%)', color: '#f59e0b' }, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (val) => val + '%' } },
                    x: { ticks: { maxRotation: 45, minRotation: 45, autoSkip: true, maxTicksLimit: 15 } }
                }
            }
        });

        if (resetZoomBtn) {
            resetZoomBtn.onclick = () => { if (chartInstance) chartInstance.resetZoom(); };
        }
    }

    function displayAnalysis(analysis) {
        if (!analysis || analysis.error) {
            resultsPanel.style.display = 'none';
            return;
        }
        resultsPanel.style.display = 'block';
        document.getElementById('winrate').innerHTML = analysis.winrate || '—';
        document.getElementById('totalEvents').innerText = analysis.totalEvents || '—';
        document.getElementById('successfulEvents').innerText = analysis.successfulEvents || '—';
        document.getElementById('closingRate').innerHTML = analysis.closingRate || '—';
        document.getElementById('verdict').innerHTML = analysis.verdict || '—';
        document.getElementById('recEntry').innerHTML = `<strong>${analysis.recommendation?.entryDrawdownPercent || '—'}%</strong>`;
        document.getElementById('recTP').innerHTML = `<strong>${analysis.recommendation?.takeProfitPercent || '—'}%</strong>`;
        document.getElementById('recMaxHold').innerHTML = `<strong>${analysis.recommendation?.maxHoldHours || '—'} ч</strong>`;
        document.getElementById('recWinrate').innerHTML = `<strong>${analysis.recommendation?.expectedWinrate || '—'}</strong>`;
    }

    async function runAnalysis() {
        const symbol = symbolInput.value.trim().toUpperCase();
        const tokenAddress = tokenAddressInput.value.trim();
        const chainId = chainIdSelect.value;
        const interval = intervalSelect.value;
        const drawdownThreshold = parseFloat(drawdownThresholdInput.value) / 100;
        const mode = periodModeSelect.value;

        if (!symbol || !tokenAddress) {
            setStatus('❌ Заполните поля или выберите токен', true);
            return;
        }

        const body = { symbol, tokenAddress, chainId, interval, drawdownThreshold };
        if (mode === 'hours') body.hours = parseInt(hoursInput.value, 10);
        else body.days = parseInt(daysInput.value, 10);

        analyzeBtn.disabled = true;
        analyzeBtn.innerText = '⏳ Загрузка...';
        setStatus('🔄 Загрузка данных...');
        resultsPanel.style.display = 'none';
        warningsDiv.style.display = 'none';

        try {
            const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const result = await response.json();
            if (!result.success) throw new Error(result.error);

            renderChart(result.chart.data);
            displayAnalysis(result.analysis);
            showWarnings(result.meta.warnings);
            showSyncInfo(result.meta);

            const loadedInfo = result.meta.requestedUnit === 'часов'
                ? `${result.meta.requestedPeriod} ${result.meta.requestedUnit}`
                : `${result.meta.requestedPeriod} ${result.meta.requestedUnit}`;
            setStatus(`✅ Данные загружены: ${loadedInfo}, ${result.chart.pointsCount} точек, синхронизация ${result.meta.syncPercent}%`, false, true);

        } catch (err) {
            setStatus(`❌ ${err.message}`, true);
        } finally {
            analyzeBtn.disabled = false;
            analyzeBtn.innerText = '🔍 АНАЛИЗИРОВАТЬ';
        }
    }

    periodModeSelect.addEventListener('change', () => {
        if (periodModeSelect.value === 'hours') {
            hoursInput.style.display = 'block';
            daysInput.style.display = 'none';
        } else {
            hoursInput.style.display = 'none';
            daysInput.style.display = 'block';
        }
    });

    analyzeBtn.addEventListener('click', runAnalysis);
    loadChains();
    loadTokensList();
});
// src/orchestrator.js
const logger = require('./core/logger');
const eventEmitter = require('./core/eventEmitter');
const dexMonitor = require('./dex/dexMonitor');
const mexcPublic = require('./cex/mexcPublic');
const statistics = require('./analyzer/statistics');

class Orchestrator {
    constructor() {
        this.isRunning = false;
        this.tokens = require('../data/tokens/tokens.js');
        this.config = {
            delayBetweenTokens: 250,     // 250ms между отправкой запросов
            cycleInterval: 2000,         // 2 секунды между циклами
            timeout: 3000                // таймаут на запрос
        };
        this.stats = {
            cycles: 0,
            processed: 0,
            errors: 0,
            totalTime: 0
        };
    }

    async start() {
        if (this.isRunning) return;

        logger.info(`📊 Токенов в списке: ${this.tokens.length}`);

        this.tokens.forEach(token => {
            logger.info(`   - ${token.symbol}: ${token.address}`);
        });

        this.isRunning = true;

        while (this.isRunning) {
            const cycleStart = Date.now();
            await this.runCycle();
            const cycleDuration = Date.now() - cycleStart;
            this.stats.totalTime += cycleDuration;

            if (this.isRunning) {
                logger.info(`⏳ Цикл завершен за ${(cycleDuration / 1000).toFixed(1)}с, ожидание ${this.config.cycleInterval / 1000}с...`);
                await this.delay(this.config.cycleInterval);
            }
        }
    }

    async runCycle() {
        this.stats.cycles++;
        logger.info(`\n🔄 ЦИКЛ ${this.stats.cycles}`);

        const promises = [];
        
        // Запускаем запросы с интервалом 250ms, не дожидаясь ответов
        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            
            // Запускаем обработку токена, сохраняем промис
            promises.push(this.processToken(token));
            
            // Ждем 250ms ПОСЛЕ отправки запроса, не дожидаясь ответа
            if (i < this.tokens.length - 1) {
                await this.delay(this.config.delayBetweenTokens);
            }
        }
        
        // Теперь ждем завершения всех запросов
        const results = await Promise.allSettled(promises);
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

        logger.info(`✅ Цикл ${this.stats.cycles} завершен: ${successCount}/${this.tokens.length} токенов обработано`);
        this.stats.processed += successCount;

        // Показываем статистику каждые 20 циклов
        if (this.stats.cycles % 20 === 0) {
            const stats = statistics.getStats();
            logger.info(`📊 Статистика: ${stats.totalSignals} сигналов, винрейт ${stats.winRate}%`);
        }
    }

    async processToken(token) {
        const startTime = Date.now();

        try {
            const dexAddress = token.address
            const cexSymbol = token.symbol;

            if (!dexAddress) {
                logger.debug(`${token.symbol}: нет DEX адреса`);
                return false;
            }

            // Параллельные запросы к DEX и CEX
            const [dexResponse, cexResponse] = await Promise.allSettled([
                this.withTimeout(dexMonitor.fetchToken(cexSymbol, dexAddress), this.config.timeout),
                this.withTimeout(mexcPublic.getTickerPrice(cexSymbol), this.config.timeout)
            ]);

            let dexData = null;
            if (dexResponse.status === 'fulfilled' && dexResponse.value && Array.isArray(dexResponse.value) && dexResponse.value.length > 0) {
                dexData = dexResponse.value[0];
            }

            let cexPrice = null;
            if (cexResponse.status === 'fulfilled' && cexResponse.value && cexResponse.value.price) {
                cexPrice = parseFloat(cexResponse.value.price);
            }

            if (!dexData || !dexData.priceUsd) {
                logger.debug(`${token.symbol}: нет DEX данных`);
                return false;
            }

            if (!cexPrice) {
                logger.debug(`${token.symbol}: нет CEX данных`);
                return false;
            }

            const dropPercent = ((dexData.priceUsd - cexPrice) / dexData.priceUsd) * 100;
            const duration = Date.now() - startTime;

            logger.info(`📊 ${token.symbol}: DEX $${dexData.priceUsd.toFixed(6)} | CEX $${cexPrice.toFixed(6)} | ликв: $${(dexData.liquidityUsd || 0).toLocaleString()} | спред ${dropPercent.toFixed(2)}% (${duration}ms)`);

            eventEmitter.emit('data:ready', {
                symbol: token.symbol,
                dexPrice: dexData.priceUsd,
                cexPrice: cexPrice,
                dexData: {
                    dexId: dexData.dexId,
                    liquidity: dexData.liquidityUsd,
                    volume: dexData.volume24h,
                    pairAddress: dexData.pairAddress
                },
                cexData: {
                    exchange: 'mexc',
                    price: cexPrice
                },
                timestamp: Date.now()
            });

            return true;

        } catch (error) {
            this.stats.errors++;
            logger.error(`${token.symbol}: ошибка - ${error.message}`);
            return false;
        }
    }

    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
            )
        ]);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        this.isRunning = false;
        const avgTime = this.stats.cycles > 0 ? (this.stats.totalTime / this.stats.cycles / 1000).toFixed(1) : 0;
        logger.info(`🛑 Оркестратор остановлен.`);
        logger.info(`   Циклов: ${this.stats.cycles}, обработано: ${this.stats.processed}, ошибок: ${this.stats.errors}`);
        logger.info(`   Среднее время цикла: ${avgTime}с`);
    }
}

module.exports = new Orchestrator();
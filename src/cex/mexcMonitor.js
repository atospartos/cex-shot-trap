// src/cex/cexMonitor.js
const mexcPublic = require('./mexcPublic');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class CexMonitor {
    async fetchPrice(tokenSymbol, cexSymbol) {
        try {
            const baseSymbol = cexSymbol.split('/')[0];
            logger.debug(`📥 CEX запрос для ${tokenSymbol} (${baseSymbol})`);

            const ticker = await mexcPublic.getTickerPrice(baseSymbol);

            if (ticker && ticker.price) {
                logger.debug(`✅ ${tokenSymbol} цена $${ticker.price}`);

                eventEmitter.emit('cex:price', {
                    symbol: tokenSymbol,
                    price: ticker.price,
                    timestamp: Date.now()
                });

                return {
                    price: ticker.price,
                    exchange: 'mexc',
                    symbol: cexSymbol
                };
            }

            logger.warn(`⚠️ Нет данных для ${tokenSymbol} (${cexSymbol})`);
            return null;

        } catch (error) {
            logger.error(`❌ Ошибка CEX для ${tokenSymbol}: ${error.message}`);
            return null;
        }
    }
    /**
     * Получить информацию о проскальзывании для заданной суммы
     * @param {string} symbol - символ токена (без USDT)
     * @param {number} amountUSD - сумма в USD
     * @returns {object} - информация о проскальзывании
     */
    async getSlippageInfo(symbol, amountUSD = this.defaultTradeAmountUSD) {
        try {
            const result = await mexcPublic.getEffectivePriceWithSlippage(symbol, 'buy', amountUSD);

            if (result.error) {
                return {
                    hasLiquidity: false,
                    error: result.error,
                    amountUSD,
                    symbol
                };
            }

            return {
                hasLiquidity: true,
                amountUSD,
                symbol,
                bestPrice: result.bestPrice,
                avgPrice: result.avgPrice,
                slippagePercent: result.slippagePercent,
                filledAmount: result.filledAmount,
                isProfitable: parseFloat(result.slippagePercent) < this.maxSlippagePercent
            };
        } catch (error) {
            return {
                hasLiquidity: false,
                error: error.message,
                amountUSD,
                symbol
            };
        }
    }

    /**
     * Проверить, достаточно ли ликвидности для сделки
     * @param {string} symbol - символ токена
     * @param {number} amountUSD - сумма в USD
     * @param {number} maxSlippagePercent - максимальное допустимое проскальзывание
     * @returns {object} - результат проверки
     */
    async checkLiquidity(symbol, amountUSD = this.defaultTradeAmountUSD, maxSlippagePercent = this.maxSlippagePercent) {
        const optimalSize = await mexcPublic.getOptimalTradeSize(symbol, 'buy', maxSlippagePercent, amountUSD * 2);

        if (optimalSize.error) {
            return {
                hasEnoughLiquidity: false,
                error: optimalSize.error,
                symbol,
                requestedAmount: amountUSD
            };
        }

        return {
            hasEnoughLiquidity: optimalSize.optimalAmountUSD >= amountUSD,
            symbol,
            requestedAmount: amountUSD,
            optimalAmountUSD: optimalSize.optimalAmountUSD,
            estimatedSlippage: optimalSize.estimatedSlippage,
            maxAllowedSlippage: maxSlippagePercent + '%',
            availableDepthUSD: optimalSize.availableDepthUSD
        };
    }

    /**
     * Получить полную информацию о цене с учётом стакана
     * @param {string} symbol - символ токена
     * @param {number} amountUSD - сумма в USD
     * @returns {object} - полная информация
     */
    async getFullPriceInfo(symbol, amountUSD = this.defaultTradeAmountUSD) {
        const [ticker, slippageInfo, liquidityInfo] = await Promise.all([
            mexcPublic.getTickerPrice(symbol),
            this.getSlippageInfo(symbol, amountUSD),
            this.checkLiquidity(symbol, amountUSD)
        ]);

        return {
            symbol,
            timestamp: Date.now(),
            marketPrice: ticker?.price || null,
            slippageInfo,
            liquidityInfo,
            recommended: {
                canTrade: slippageInfo.hasLiquidity && liquidityInfo.hasEnoughLiquidity,
                effectivePrice: slippageInfo.avgPrice || ticker?.price,
                slippagePercent: slippageInfo.slippagePercent,
                maxTradeAmount: liquidityInfo.optimalAmountUSD
            }
        };
    }
}

module.exports = new CexMonitor();
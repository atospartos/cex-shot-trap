// src/cex/mexcPublic.js
const axios = require('axios');
const logger = require('../core/logger');

class MexcPublic {
    constructor() {
        this.baseURL = 'https://api.mexc.com';
    }

    async getTickerPrice(symbol) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/ticker/price`, {
                params: { symbol: `${symbol}USDT` },
                timeout: 5000
            });

            if (response.data && response.data.price) {
                return {
                    symbol,
                    price: parseFloat(response.data.price),
                    timestamp: Date.now()
                };
            }
            return null;
        } catch (error) {
            logger.debug(`Ошибка получения цены ${symbol}: ${error.message}`);
            return null;
        }
    }

    async getTicker24hr(symbol) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/ticker/24hr`, {
                params: { symbol: `${symbol}USDT` },
                timeout: 5000
            });
            return response.data;
        } catch (error) {
            logger.debug(`Ошибка 24hr статистики ${symbol}: ${error.message}`);
            return null;
        }
    }

    async getOrderBook(symbol, limit = 100) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/depth`, {
                params: { symbol: `${symbol}USDT`, limit },
                timeout: 5000
            });
            return response.data;
        } catch (error) {
            logger.debug(`Ошибка книги ордеров ${symbol}: ${error.message}`);
            return null;
        }
    }

    /**
     * Расчёт эффективной цены с учётом проскальзывания в стакане
     * @param {string} symbol - символ токена (без USDT)
     * @param {string} side - 'buy' или 'sell'
     * @param {number} amountUSD - сумма в USD для покупки/продажи
     * @param {number} limit - глубина стакана (по умолчанию 100)
     * @returns {object} - { effectivePrice, avgPrice, slippagePercent, filledAmount, filledQuantity, orderBook }
     */
    async getEffectivePriceWithSlippage(symbol, side, amountUSD, limit = 100) {
        try {
            // Получаем стакан
            const orderBook = await this.getOrderBook(symbol, limit);
            if (!orderBook) {
                return { error: 'Не удалось получить книгу ордеров' };
            }

            const orders = side === 'buy' ? orderBook.asks : orderBook.bids;
            if (!orders || orders.length === 0) {
                return { error: 'Стакан пуст' };
            }

            let remainingUSD = amountUSD;
            let totalQuantity = 0;
            let totalCost = 0;
            let usedOrders = [];

            for (const order of orders) {
                const price = parseFloat(order[0]);
                const quantity = parseFloat(order[1]);
                const orderValueUSD = price * quantity;

                if (orderValueUSD >= remainingUSD) {
                    // Частичное исполнение на этом уровне
                    const quantityFilled = remainingUSD / price;
                    totalQuantity += quantityFilled;
                    totalCost += remainingUSD;
                    usedOrders.push({
                        price,
                        quantity: quantityFilled,
                        valueUSD: remainingUSD,
                        fullMatch: false
                    });
                    remainingUSD = 0;
                    break;
                } else {
                    // Полное исполнение уровня
                    totalQuantity += quantity;
                    totalCost += orderValueUSD;
                    usedOrders.push({
                        price,
                        quantity,
                        valueUSD: orderValueUSD,
                        fullMatch: true
                    });
                    remainingUSD -= orderValueUSD;
                }
            }

            if (remainingUSD > 0) {
                return {
                    error: `Недостаточно ликвидности. Доступно: ${(totalCost).toFixed(2)}$ из ${amountUSD}$`,
                    availableUSD: totalCost,
                    requestedUSD: amountUSD,
                    shortfallUSD: remainingUSD
                };
            }

            const avgPrice = totalCost / totalQuantity;
            const bestPrice = parseFloat(orders[0][0]);
            const slippagePercent = Math.abs((avgPrice - bestPrice) / bestPrice) * 100;

            return {
                success: true,
                side,
                symbol,
                amountUSD,
                bestPrice,
                avgPrice,
                slippagePercent: slippagePercent.toFixed(4),
                filledQuantity: totalQuantity,
                filledAmount: totalCost,
                usedOrders: usedOrders.slice(0, 5), // первые 5 уровней для отладки
                orderBookDepth: {
                    bids: orderBook.bids?.slice(0, 5).map(b => ({ price: b[0], qty: b[1] })),
                    asks: orderBook.asks?.slice(0, 5).map(a => ({ price: a[0], qty: a[1] }))
                }
            };

        } catch (error) {
            logger.error(`Ошибка расчёта проскальзывания для ${symbol}: ${error.message}`);
            return { error: error.message };
        }
    }

    /**
     * Расчёт оптимального размера сделки для заданного максимального проскальзывания
     * @param {string} symbol - символ токена (без USDT)
     * @param {string} side - 'buy' или 'sell'
     * @param {number} maxSlippagePercent - максимальное допустимое проскальзывание (%)
     * @param {number} maxAmountUSD - максимальная сумма для проверки
     * @returns {object} - { optimalAmountUSD, estimatedSlippage, availableDepthUSD }
     */
    async getOptimalTradeSize(symbol, side, maxSlippagePercent = 0.5, maxAmountUSD = 1000) {
        try {
            const orderBook = await this.getOrderBook(symbol, 100);
            if (!orderBook) {
                return { error: 'Не удалось получить книгу ордеров' };
            }

            const orders = side === 'buy' ? orderBook.asks : orderBook.bids;
            if (!orders || orders.length === 0) {
                return { error: 'Стакан пуст' };
            }

            let cumulativeUSD = 0;
            let cumulativeQuantity = 0;
            let optimalAmount = 0;
            let optimalSlippage = 0;
            let lastPrice = parseFloat(orders[0][0]);

            for (const order of orders) {
                const price = parseFloat(order[0]);
                const quantity = parseFloat(order[1]);
                const orderValueUSD = price * quantity;
                const newCumulativeUSD = cumulativeUSD + orderValueUSD;

                // Средняя цена после добавления этого уровня
                const newCumulativeQuantity = cumulativeQuantity + quantity;
                const newAvgPrice = newCumulativeUSD / newCumulativeQuantity;
                const slippage = Math.abs((newAvgPrice - lastPrice) / lastPrice) * 100;

                if (slippage <= maxSlippagePercent && newCumulativeUSD <= maxAmountUSD) {
                    cumulativeUSD = newCumulativeUSD;
                    cumulativeQuantity = newCumulativeQuantity;
                    optimalAmount = cumulativeUSD;
                    optimalSlippage = slippage;
                } else {
                    break;
                }
            }

            return {
                success: true,
                side,
                symbol,
                optimalAmountUSD: optimalAmount,
                estimatedSlippage: optimalSlippage.toFixed(4) + '%',
                maxAllowedSlippage: maxSlippagePercent + '%',
                availableDepthUSD: cumulativeUSD,
                bestPrice: lastPrice,
                avgPriceAtOptimal: cumulativeUSD / cumulativeQuantity
            };

        } catch (error) {
            logger.error(`Ошибка расчёта оптимального размера для ${symbol}: ${error.message}`);
            return { error: error.message };
        }
    }

    async ping() {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/ping`);
            return response.status === 200;
        } catch (error) {
            return false;
        }
    }

    async getServerTime() {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/time`);
            return response.data?.serverTime;
        } catch (error) {
            return null;
        }
    }
}

module.exports = new MexcPublic();
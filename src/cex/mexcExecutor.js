// src/cex/mexcExecutor.js
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const mexcPrivate = require('./mexcPrivate');

const DATA_DIR = path.join(process.cwd(), 'data');
const TRAPS_FILE = path.join(DATA_DIR, 'traps.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

class MexcExecutor {
    constructor() {
        this.activeTraps = new Map();
        this.activePositions = new Map();

        this.risk = {
            dailyLoss: 0,
            dailyTrades: 0,
            dailyDate: this.getToday(),
            tokenStats: new Map(),
            config: {
                maxDailyLoss: 50,
                maxConsecutiveLosses: 6,
                cooldownMinutes: 40,
                maxPositionSize: 5,
                maxTotalExposure: 20
            }
        };

        this.maxActiveTimeMs = 3 * 60 * 60 * 1000;
        this.isHalted = false;
        this.haltedReason = null;

        this.setupListeners();
        this.loadState();
        this.startMonitor();
        this.startDailyReset();

        logger.info('🚀 MEXC Executor (лонг-ловушка) запущен');
    }

    getToday() {
        return new Date().toISOString().split('T')[0];
    }

    setupListeners() {
        eventEmitter.on('signal:create_trap', this.onCreateTrap.bind(this));
        eventEmitter.on('signal:update_trap', this.onUpdateTrap.bind(this));
        eventEmitter.on('signal:cancel_trap', this.onCancelTrap.bind(this));
        eventEmitter.on('signal:update_take_profit', this.onUpdateTakeProfit.bind(this));
        eventEmitter.on('signal:close_position', this.onClosePosition.bind(this));
    }

    // ==================== РИСК-МЕНЕДЖМЕНТ ====================

    startDailyReset() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        setTimeout(() => {
            this.resetDailyStats();
            setInterval(() => this.resetDailyStats(), 24 * 60 * 60 * 1000);
        }, tomorrow - now);
    }

    resetDailyStats() {
        this.risk.dailyLoss = 0;
        this.risk.dailyTrades = 0;
        this.risk.dailyDate = this.getToday();
        this.isHalted = false;
        this.haltedReason = null;
        this.saveState();
        logger.info(`📅 Дневная статистика сброшена (${this.risk.dailyDate})`);
    }

    canOpenPosition(symbol, size) {
        if (this.isHalted) {
            logger.warn(`⚠️ Торговля остановлена: ${this.haltedReason}`);
            return false;
        }

        if (this.risk.dailyLoss >= this.risk.config.maxDailyLoss) {
            logger.warn(`⚠️ Дневной лимит убытка: $${this.risk.dailyLoss}`);
            return false;
        }

        const stats = this.risk.tokenStats.get(symbol);
        if (stats && stats.consecutiveLosses >= this.risk.config.maxConsecutiveLosses) {
            const cooldownRemaining = (stats.lastTradeTime + this.risk.config.cooldownMinutes * 60 * 1000) - Date.now();
            if (cooldownRemaining > 0) {
                logger.warn(`⏸️ ${symbol}: кулдаун ${Math.ceil(cooldownRemaining / 60000)} мин`);
                return false;
            }
            stats.consecutiveLosses = 0;
        }

        const totalExposure = this.getTotalExposure();
        if (totalExposure + size > this.risk.config.maxTotalExposure) {
            logger.warn(`⚠️ Превышение депозита: $${totalExposure + size}`);
            return false;
        }

        return true;
    }

    getTotalExposure() {
        let total = 0;
        for (const trap of this.activeTraps.values()) total += trap.size;
        for (const pos of this.activePositions.values()) total += pos.size;
        return total;
    }

    updateTokenStats(symbol, profit) {
        let stats = this.risk.tokenStats.get(symbol);
        if (!stats) {
            stats = { consecutiveLosses: 0, totalProfit: 0, lastTradeTime: 0 };
            this.risk.tokenStats.set(symbol, stats);
        }

        if (profit > 0) {
            stats.consecutiveLosses = 0;
        } else {
            stats.consecutiveLosses++;
        }
        stats.totalProfit += profit;
        stats.lastTradeTime = Date.now();
        this.saveState();
    }

    updateDailyStats(profit) {
        if (profit < 0) this.risk.dailyLoss += Math.abs(profit);
        this.risk.dailyTrades++;
        this.saveState();

        if (this.risk.dailyLoss >= this.risk.config.maxDailyLoss) {
            logger.error(`🛑 ДНЕВНОЙ ЛИМИТ: $${this.risk.dailyLoss}`);
            this.isHalted = true;
            this.haltedReason = 'daily_loss_limit';
        }
    }

    updateRiskConfig(newConfig) {
        this.risk.config = { ...this.risk.config, ...newConfig };
        logger.info(`⚙️ Обновлена конфигурация риска:`, this.risk.config);
    }

    getStats() {
        return {
            dailyLoss: this.risk.dailyLoss,
            dailyTrades: this.risk.dailyTrades,
            activeTraps: this.activeTraps.size,
            activePositions: this.activePositions.size,
            totalExposure: this.getTotalExposure(),
            isHalted: this.isHalted,
            haltedReason: this.haltedReason,
            tokenStats: Object.fromEntries(this.risk.tokenStats)
        };
    }

    // ==================== ЛОВУШКА ====================

    async onCreateTrap({ symbol, dexPrice, trapPrice, size }) {
        if (!this.canOpenPosition(symbol, size)) {
            logger.warn(`${symbol}: отклонено риск-менеджментом`);
            return;
        }

        if (this.activeTraps.has(symbol) || this.activePositions.has(symbol)) {
            logger.warn(`${symbol}: уже есть активная позиция`);
            return;
        }

        logger.info(`📌 ЛОВУШКА ${symbol}: BUY LIMIT ${trapPrice}, size ${size}`);

        try {
            const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', size, trapPrice);

            if (order?.orderId) {
                this.activeTraps.set(symbol, {
                    symbol, dexPrice, trapPrice, size,
                    totalSize: size,
                    orderId: order.orderId,
                    createdAt: Date.now()
                });
                this.saveState();
                logger.info(`✅ Ловушка ${symbol} выставлена`);
            }
        } catch (error) {
            logger.error(`❌ Ошибка создания ловушки ${symbol}: ${error.message}`);
            eventEmitter.emit('error:executor', {
                symbol,
                error: error.message,
                action: 'create_trap'
            });
        }
    }

    async onUpdateTrap({ symbol, newTrapPrice, newDexPrice }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;

        try {
            logger.info(`🔄 Обновление ловушки ${symbol}: ${trap.trapPrice} → ${newTrapPrice}`);

            if (trap.orderId) {
                await mexcPrivate.cancelOrder(symbol, trap.orderId);
            }

            const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', trap.size, newTrapPrice);

            if (order?.orderId) {
                trap.trapPrice = newTrapPrice;
                trap.dexPrice = newDexPrice;
                trap.orderId = order.orderId;
                this.saveState();
                logger.info(`✅ Ловушка ${symbol} обновлена`);
            }
        } catch (error) {
            logger.error(`❌ Ошибка обновления ловушки ${symbol}: ${error.message}`);
            this.activeTraps.delete(symbol);
            this.saveState();
            eventEmitter.emit('error:executor', {
                symbol,
                error: error.message,
                action: 'update_trap'
            });
        }
    }

    async onCancelTrap({ symbol }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;

        try {
            if (trap.orderId) {
                await mexcPrivate.cancelOrder(symbol, trap.orderId);
            }
        } catch (error) {
            logger.debug(`Ошибка отмены ордера ${symbol}: ${error.message}`);
        }

        this.activeTraps.delete(symbol);
        this.saveState();

        eventEmitter.emit('trap:cancelled', {
            symbol,
            reason: 'manual',
            trapPrice: trap.trapPrice,
            dexPrice: trap.dexPrice
        });

        logger.info(`❌ Ловушка ${symbol} отменена`);
    }

    // ==================== ТЕЙК-ПРОФИТ ====================

    async onUpdateTakeProfit({ symbol, newTakeProfit, size }) {
        const position = this.activePositions.get(symbol);
        if (!position) return;

        logger.info(`🎯 ТЕЙК ${symbol}: SELL LIMIT ${newTakeProfit}, size ${size}`);

        try {
            if (position.tpOrderId) {
                await mexcPrivate.cancelOrder(symbol, position.tpOrderId);
            }

            const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', size, newTakeProfit);

            if (order?.orderId) {
                position.tpOrderId = order.orderId;
                position.takeProfitPrice = newTakeProfit;
                this.saveState();
            }
        } catch (error) {
            logger.error(`❌ Ошибка установки тейка ${symbol}: ${error.message}`);
            eventEmitter.emit('error:executor', {
                symbol,
                error: error.message,
                action: 'update_take_profit'
            });
        }
    }

    // ==================== ОБРАБОТКА ИСПОЛНЕНИЯ ====================

    async onTrapFilled(symbol, fillPrice, fillSize) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;

        const remainingSize = trap.size - fillSize;

        logger.info(`🎯 ЛОВУШКА СРАБОТАЛА ${symbol}: ${fillSize}/${trap.totalSize} по ${fillPrice}`);

        if (remainingSize > 0) {
            // ЧАСТИЧНОЕ ИСПОЛНЕНИЕ
            trap.size = remainingSize;
            this.saveState();

            eventEmitter.emit('position:partial_opened', {
                symbol,
                entryPrice: fillPrice,
                dexPrice: trap.dexPrice,
                filledSize: fillSize,
                remainingSize: remainingSize,
                totalSize: trap.totalSize
            });

            logger.info(`📊 ЧАСТИЧНОЕ ИСПОЛНЕНИЕ ${symbol}: открыто ${fillSize} USDT, осталось ${remainingSize} USDT`);

        } else {
            // ПОЛНОЕ ИСПОЛНЕНИЕ
            this.activeTraps.delete(symbol);

            const position = {
                symbol,
                entryPrice: fillPrice,
                size: fillSize,
                entryTime: Date.now(),
                dexPrice: trap.dexPrice,
                tpOrderId: null,
                takeProfitPrice: null
            };

            this.activePositions.set(symbol, position);

            setTimeout(() => this.checkActiveTimeout(symbol), this.maxActiveTimeMs);
            this.saveState();

            eventEmitter.emit('position:opened', {
                symbol,
                entryPrice: fillPrice,
                dexPrice: trap.dexPrice,
                size: fillSize
            });

            logger.info(`✅ ПОЗИЦИЯ ${symbol} ОТКРЫТА: $${fillPrice}, размер ${fillSize} USDT`);
        }
    }

    async onTakeProfitFilled(symbol, fillPrice, fillSize) {
        const position = this.activePositions.get(symbol);
        if (!position) return;

        const profit = (fillPrice - position.entryPrice) * fillSize;
        const profitPercent = ((fillPrice - position.entryPrice) / position.entryPrice) * 100;

        this.updateTokenStats(symbol, profit);
        this.updateDailyStats(profit);

        logger.info(`💰 РЕЗУЛЬТАТ ${symbol}: ${profit > 0 ? '+' : ''}$${profit.toFixed(4)} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);

        if (fillSize >= position.size) {
            // Полное закрытие
            this.activePositions.delete(symbol);
            eventEmitter.emit('position:closed', {
                symbol,
                reason: 'take_profit',
                profitPercent,
                filledSize
            });
        } else {
            // Частичное закрытие
            position.size -= fillSize;
            this.saveState();

            eventEmitter.emit('position:partial_closed', {
                symbol,
                reason: 'take_profit',
                profitPercent,
                filledSize,
                remainingSize: position.size
            });

            logger.info(`📊 ЧАСТИЧНОЕ ЗАКРЫТИЕ ${symbol}: закрыто ${fillSize} USDT, осталось ${position.size} USDT`);
        }
    }

    // ==================== ТАЙМАУТ ====================

    async checkActiveTimeout(symbol) {
        const position = this.activePositions.get(symbol);
        if (!position) return;

        const currentPrice = await this.getCurrentPrice(symbol);
        if (!currentPrice) return;

        const profitPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        logger.warn(`⏰ ТАЙМАУТ ПОЗИЦИИ ${symbol} (3 часа): текущая цена $${currentPrice}, профит ${profitPercent.toFixed(2)}%`);

        // Смещение на 0.01% ниже текущей цены для приоритета исполнения
        const offsetPercent = 0.01;
        const limitPrice = currentPrice * (1 - offsetPercent / 100);

        logger.info(`📉 Выставляем лимитный ордер на закрытие ${symbol}: SELL LIMIT ${limitPrice} (отступ 0.01% от ${currentPrice})`);

        try {
            const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', position.size, limitPrice);

            if (order?.orderId) {
                // Не закрываем позицию сразу, ждём исполнения
                // Сохраняем информацию о таймаутном ордере
                position.timeoutOrderId = order.orderId;
                position.timeoutLimitPrice = limitPrice;
                this.saveState();

                logger.info(`⏳ Выставлен лимитный ордер на закрытие ${symbol} по таймауту (ID: ${order.orderId})`);

                // Запускаем таймер для проверки исполнения (если не исполнился за 5 минут — повышаем цену)
                setTimeout(() => this.checkTimeoutOrder(symbol), 5 * 60 * 1000);
            }
        } catch (error) {
            logger.error(`❌ Ошибка выставления лимитного ордера ${symbol}: ${error.message}`);
            eventEmitter.emit('error:executor', {
                symbol,
                error: error.message,
                action: 'timeout_close'
            });
        }
    }

    async checkTimeoutOrder(symbol) {
        const position = this.activePositions.get(symbol);
        if (!position || !position.timeoutOrderId) return;

        const order = await mexcPrivate.getOrder(symbol, position.timeoutOrderId);

        if (order?.status === 'FILLED') {
            // Уже исполнилось (обработается в checkOrders)
            return;
        }

        if (order?.status === 'CANCELED' || order?.status === 'EXPIRED') {
            // Ордер отменён — пробуем снова с большим смещением
            const currentPrice = await this.getCurrentPrice(symbol);
            if (!currentPrice) return;

            const newLimitPrice = currentPrice * (1 - 0.05 / 100); // 0.05% смещение
            logger.warn(`🔄 Повторная попытка закрытия ${symbol}: лимит ${newLimitPrice}`);

            const newOrder = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', position.size, newLimitPrice);

            if (newOrder?.orderId) {
                position.timeoutOrderId = newOrder.orderId;
                position.timeoutLimitPrice = newLimitPrice;
                this.saveState();

                // Ещё одна попытка через 5 минут
                setTimeout(() => this.checkTimeoutOrder(symbol), 5 * 60 * 1000);
            }
        }
    }

    // ==================== ВСПОМОГАТЕЛЬНЫЕ ====================

    async getCurrentPrice(symbol) {
        try {
            const orderBook = await mexcPrivate.getOrderBook(symbol);
            return orderBook?.bids[0]?.[0] || null;
        } catch (error) {
            logger.debug(`Ошибка получения цены ${symbol}: ${error.message}`);
            return null;
        }
    }

    async emergencyCloseAll() {
        logger.warn('🛑 АВАРИЙНОЕ ЗАКРЫТИЕ ВСЕХ ПОЗИЦИЙ');

        for (const [symbol, position] of this.activePositions) {
            try {
                const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'MARKET', position.size);
                if (order?.orderId) {
                    logger.info(`✅ Аварийно закрыта позиция ${symbol}`);
                    eventEmitter.emit('position:closed', {
                        symbol,
                        reason: 'emergency',
                        profitPercent: 0,
                        filledSize: position.size
                    });
                }
            } catch (error) {
                logger.error(`❌ Ошибка закрытия ${symbol}: ${error.message}`);
            }
        }

        for (const [symbol, trap] of this.activeTraps) {
            await this.onCancelTrap({ symbol });
        }

        this.isHalted = true;
        this.haltedReason = 'emergency_close';
        this.saveState();
    }

    // ==================== МОНИТОРИНГ ====================

    startMonitor() {
        setInterval(() => this.checkOrders(), 2000);
    }

    async checkOrders() {
        // ==================== 1. ПРОВЕРКА ЛОВУШЕК ====================
        for (const [symbol, trap] of this.activeTraps) {
            try {
                const order = await mexcPrivate.getOrder(symbol, trap.orderId);

                if (order?.status === 'FILLED') {
                    await this.onTrapFilled(symbol, order.price, trap.size);
                }
                else if (order?.status === 'PARTIALLY_FILLED') {
                    const filledSize = parseFloat(order.executedQty);
                    await this.onTrapFilled(symbol, order.price, filledSize);
                }
                else if (order?.status === 'CANCELED') {
                    this.activeTraps.delete(symbol);
                    this.saveState();

                    eventEmitter.emit('trap:cancelled', {
                        symbol,
                        reason: 'order_cancelled',
                        trapPrice: trap.trapPrice,
                        dexPrice: trap.dexPrice
                    });

                    logger.info(`❌ Ловушка ${symbol} отменена (ордер отменён)`);
                }
            } catch (error) {
                logger.error(`❌ Ошибка проверки ловушки ${symbol}: ${error.message}`);
            }
        }

        // ==================== 2. ПРОВЕРКА ТЕЙКОВ ====================
        for (const [symbol, position] of this.activePositions) {
            if (!position.tpOrderId) continue;

            try {
                const order = await mexcPrivate.getOrder(symbol, position.tpOrderId);

                if (order?.status === 'FILLED') {
                    await this.onTakeProfitFilled(symbol, order.price, position.size);
                }
                else if (order?.status === 'PARTIALLY_FILLED') {
                    const filledSize = parseFloat(order.executedQty);
                    await this.onTakeProfitFilled(symbol, order.price, filledSize);
                }
                else if (order?.status === 'CANCELED') {
                    position.tpOrderId = null;
                    this.saveState();
                    logger.warn(`⚠️ Тейк-ордер ${symbol} отменён`);
                }
            } catch (error) {
                logger.error(`❌ Ошибка проверки тейка ${symbol}: ${error.message}`);
            }
        }

        // ==================== 3. ПРОВЕРКА ТАЙМАУТНЫХ ОРДЕРОВ ====================
        for (const [symbol, position] of this.activePositions) {
            if (!position.timeoutOrderId) continue;

            try {
                const order = await mexcPrivate.getOrder(symbol, position.timeoutOrderId);

                if (order?.status === 'FILLED') {
                    // Ордер исполнился — закрываем позицию
                    const profit = (order.price - position.entryPrice) * position.size;
                    const profitPercent = ((order.price - position.entryPrice) / position.entryPrice) * 100;

                    this.updateTokenStats(symbol, profit);
                    this.updateDailyStats(profit);

                    this.activePositions.delete(symbol);
                    this.saveState();

                    eventEmitter.emit('position:closed', {
                        symbol,
                        reason: 'timeout',
                        profitPercent,
                        filledSize: position.size,
                        closedPrice: order.price
                    });

                    logger.info(`✅ Позиция ${symbol} закрыта по таймауту: $${order.price} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
                }
                else if (order?.status === 'CANCELED' || order?.status === 'EXPIRED') {
                    // Ордер отменён или истёк — убираем флаг
                    position.timeoutOrderId = null;
                    this.saveState();
                    logger.warn(`⚠️ Таймаут-ордер ${symbol} отменён, ждём следующую попытку`);
                }
            } catch (error) {
                logger.error(`❌ Ошибка проверки таймаут-ордера ${symbol}: ${error.message}`);
                position.timeoutOrderId = null;
                this.saveState();
            }
        }
    }
    // ==================== ЗАКРЫТИЕ ПОЗИЦИИ ====================

    async onClosePosition({ symbol, size, price, reason }) {
        const position = this.activePositions.get(symbol);
        if (!position) return;

        logger.info(`🔒 ЗАКРЫТИЕ ПОЗИЦИИ ${symbol}: ${size} USDT, причина: ${reason}`);

        try {
            const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', size, price);

            if (order?.orderId) {
                const profit = (price - position.entryPrice) * size;
                this.updateTokenStats(symbol, profit);
                this.updateDailyStats(profit);

                if (size >= position.size) {
                    this.activePositions.delete(symbol);
                    eventEmitter.emit('position:closed', {
                        symbol,
                        reason,
                        profitPercent: ((price - position.entryPrice) / position.entryPrice) * 100,
                        filledSize: size
                    });
                } else {
                    position.size -= size;
                    this.saveState();
                    eventEmitter.emit('position:partial_closed', {
                        symbol,
                        reason,
                        profitPercent: ((price - position.entryPrice) / position.entryPrice) * 100,
                        filledSize: size,
                        remainingSize: position.size
                    });
                }

                logger.info(`✅ Позиция ${symbol} закрыта лимитом ${price}`);
            }
        } catch (error) {
            logger.error(`❌ Ошибка закрытия позиции ${symbol}: ${error.message}`);
            eventEmitter.emit('error:executor', {
                symbol,
                error: error.message,
                action: 'close_position'
            });
        }
    }

    // ==================== ЗАГРУЗКА/СОХРАНЕНИЕ ====================

    ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    loadState() {
        this.ensureDataDir();

        try {
            if (fs.existsSync(TRAPS_FILE)) {
                const data = JSON.parse(fs.readFileSync(TRAPS_FILE));
                for (const [symbol, trap] of Object.entries(data.traps || {})) {
                    this.activeTraps.set(symbol, trap);
                }
                for (const [symbol, pos] of Object.entries(data.positions || {})) {
                    this.activePositions.set(symbol, pos);
                }
                logger.info(`📂 Загружено: ${this.activeTraps.size} ловушек, ${this.activePositions.size} позиций`);
            }

            if (fs.existsSync(STATS_FILE)) {
                const stats = JSON.parse(fs.readFileSync(STATS_FILE));
                this.risk.dailyLoss = stats.dailyLoss || 0;
                this.risk.dailyTrades = stats.dailyTrades || 0;
                this.risk.dailyDate = stats.dailyDate || this.getToday();

                if (stats.tokenStats) {
                    for (const [symbol, s] of Object.entries(stats.tokenStats)) {
                        this.risk.tokenStats.set(symbol, s);
                    }
                }
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки состояния: ${error.message}`);
        }
    }

    saveState() {
        this.ensureDataDir();

        const data = {
            traps: Object.fromEntries(this.activeTraps),
            positions: Object.fromEntries(this.activePositions),
            updated: Date.now()
        };
        fs.writeFileSync(TRAPS_FILE, JSON.stringify(data, null, 2));

        const stats = {
            dailyLoss: this.risk.dailyLoss,
            dailyTrades: this.risk.dailyTrades,
            dailyDate: this.risk.dailyDate,
            tokenStats: Object.fromEntries(this.risk.tokenStats)
        };
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    }

    async shutdown() {
        for (const [symbol, trap] of this.activeTraps) {
            await mexcPrivate.cancelOrder(symbol, trap.orderId);
        }
        for (const [symbol, position] of this.activePositions) {
            if (position.tpOrderId) {
                await mexcPrivate.cancelOrder(symbol, position.tpOrderId);
            }
        }
        this.saveState();
        logger.info('🛑 Executor остановлен');
    }
}

module.exports = new MexcExecutor();
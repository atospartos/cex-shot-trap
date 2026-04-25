// src/analytics/analyzer.js
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class Analyzer {
    constructor() {
        this.activeTraps = new Map();        
        this.activePositions = new Map();     // полностью исполненные позиции
        this.partialPositions = new Map();    // частично исполненные позиции
        
        this.priceHistory = new Map();
        this.tokensConfig = new Map();

        this.defaultConfig = {
            trapOffsetPercent: 10,
            takeProfitRecoveryPercent: 70,
            positionSize: 5,
            maxConsecutiveLosses: 3,
            cooldownMinutes: 60,
            maxDexDropPercent: 15,
            trapApproachThreshold: 50
        };

        this.positionTimeoutMs = 3 * 60 * 60 * 1000;

        this.setupListeners();
        this.loadTokensConfig();
        
        logger.info('🔍 Анализатор (лонг-ловушка) инициализирован');
    }

    loadTokensConfig() {
        try {
            const tokens = require('../data/tokens');
            for (const token of tokens) {
                if (token.strategy) {
                    this.tokensConfig.set(token.symbol, {
                        trapOffsetPercent: token.strategy.trapOffsetPercent || this.defaultConfig.trapOffsetPercent,
                        takeProfitRecoveryPercent: token.strategy.takeProfitRecoveryPercent || this.defaultConfig.takeProfitRecoveryPercent,
                        positionSize: token.strategy.positionSize || this.defaultConfig.positionSize,
                        maxConsecutiveLosses: token.strategy.maxConsecutiveLosses || this.defaultConfig.maxConsecutiveLosses,
                        cooldownMinutes: token.strategy.cooldownMinutes || this.defaultConfig.cooldownMinutes,
                        maxDexDropPercent: token.strategy.maxDexDropPercent || this.defaultConfig.maxDexDropPercent,
                        trapApproachThreshold: token.strategy.trapApproachThreshold || this.defaultConfig.trapApproachThreshold
                    });
                } else {
                    this.tokensConfig.set(token.symbol, { ...this.defaultConfig });
                }
            }
            logger.info(`📋 Загружена конфигурация для ${this.tokensConfig.size} токенов`);
        } catch (error) {
            logger.warn(`Ошибка загрузки конфигурации: ${error.message}`);
        }
    }

    getTokenConfig(symbol) {
        return this.tokensConfig.get(symbol) || this.defaultConfig;
    }

    setupListeners() {
        eventEmitter.on('data:ready', this.processData.bind(this));
        eventEmitter.on('position:opened', this.onPositionOpened.bind(this));
        eventEmitter.on('position:partial_opened', this.onPartialPositionOpened.bind(this));
        eventEmitter.on('position:closed', this.onPositionClosed.bind(this));
        eventEmitter.on('position:partial_closed', this.onPartialPositionClosed.bind(this));
        eventEmitter.on('trap:cancelled', this.onTrapCancelled.bind(this));
        eventEmitter.on('error:executor', this.onExecutorError.bind(this));
    }

    // ==================== ИСТОРИЯ ЦЕН ====================

    updatePriceHistory(symbol, dexPrice, cexPrice, timestamp) {
        if (!this.priceHistory.has(symbol)) {
            this.priceHistory.set(symbol, { dex: [], cex: [] });
        }
        const history = this.priceHistory.get(symbol);
        history.dex.push({ price: dexPrice, timestamp });
        history.cex.push({ price: cexPrice, timestamp });

        const cutoff = timestamp - (24 * 60 * 60 * 1000);
        history.dex = history.dex.filter(h => h.timestamp > cutoff);
        history.cex = history.cex.filter(h => h.timestamp > cutoff);
    }

    getLatestDexPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        return history?.dex[history.dex.length - 1]?.price || null;
    }

    getLatestCexPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        return history?.cex[history.cex.length - 1]?.price || null;
    }

    // ==================== РАСЧЁТ ЦЕН ====================

    calculateTrapPrice(dexPrice, offsetPercent) {
        return dexPrice * (1 - offsetPercent / 100);
    }

    calculateTakeProfitPrice(entryPrice, currentDexPrice, currentCexPrice, recoveryPercent) {
        if (currentDexPrice < currentCexPrice) {
            return currentCexPrice;
        }
        const fullGap = currentDexPrice - entryPrice;
        const recoveryAmount = fullGap * (recoveryPercent / 100);
        return entryPrice + recoveryAmount;
    }

    // ==================== ОСНОВНАЯ ЛОГИКА ====================

    processData({ symbol, dexPrice, cexPrice, timestamp }) {
        if (!dexPrice || !cexPrice) return;

        this.updatePriceHistory(symbol, dexPrice, cexPrice, timestamp);

        const activeTrap = this.activeTraps.get(symbol);
        const fullPosition = this.activePositions.get(symbol);
        const partialPosition = this.partialPositions.get(symbol);

        // Обновляем существующие позиции
        if (fullPosition) {
            this.updateActivePosition(symbol, fullPosition, dexPrice, cexPrice);
        }
        if (partialPosition) {
            this.updatePartialPosition(symbol, partialPosition, dexPrice, cexPrice);
        }

        // Обновляем или создаём ловушку (только если нет активных позиций)
        if (!fullPosition && !partialPosition) {
            if (activeTrap) {
                this.updateActiveTrap(symbol, activeTrap, dexPrice, cexPrice);
            } else {
                this.createTrap(symbol, dexPrice, cexPrice, timestamp);
            }
        }
    }

    // ==================== ЛОВУШКА ====================

    createTrap(symbol, dexPrice, cexPrice, timestamp) {
        const config = this.getTokenConfig(symbol);
        const trapPrice = this.calculateTrapPrice(dexPrice, config.trapOffsetPercent);
        const takeProfitPrice = this.calculateTakeProfitPrice(
            trapPrice, dexPrice, cexPrice, config.takeProfitRecoveryPercent
        );

        const trap = {
            symbol,
            createdAt: timestamp,
            dexPrice,
            cexPrice,
            originalDexPrice: dexPrice,
            originalCexPrice: cexPrice,
            trapPrice,
            takeProfitPrice,
            lastDexPrice: dexPrice,
            lastCexPrice: cexPrice,
            status: 'pending',
            remainingSize: config.positionSize,
            totalSize: config.positionSize,
            config
        };

        this.activeTraps.set(symbol, trap);

        logger.debug(`📌 ЛОВУШКА ${symbol}: $${trapPrice} (отступ ${config.trapOffsetPercent}%)`);

        eventEmitter.emit('signal:create_trap', {
            symbol,
            dexPrice,
            trapPrice,
            takeProfitPrice,
            size: config.positionSize
        });
    }

    updateActiveTrap(symbol, trap, dexPrice, cexPrice) {
        const config = trap.config;
        const isNotExecuted = trap.status === 'pending';
        
        if (!isNotExecuted) return;

        const newTrapPrice = this.calculateTrapPrice(dexPrice, config.trapOffsetPercent);
        
        // 1. Резкое падение DEX — отмена
        const dexDropPercent = ((trap.originalDexPrice - dexPrice) / trap.originalDexPrice) * 100;
        if (dexDropPercent >= config.maxDexDropPercent) {
            logger.warn(`🛡️ РЕЗКОЕ ПАДЕНИЕ DEX ${symbol}: ${dexDropPercent.toFixed(1)}%`);
            this.cancelTrap(symbol, trap, 'dex_drop');
            return;
        }

        // 2. Приближение DEX к ловушке — перестановка
        const originalDistance = trap.originalDexPrice - trap.trapPrice;
        const currentDistance = dexPrice - trap.trapPrice;
        const approachPercent = originalDistance > 0 
            ? ((originalDistance - currentDistance) / originalDistance) * 100 
            : 0;

        if (approachPercent >= config.trapApproachThreshold && currentDistance > 0) {
            logger.info(`🔄 ПРИБЛИЖЕНИЕ DEX К ЛОВУШКЕ ${symbol}: ${approachPercent.toFixed(1)}%`);
            trap.trapPrice = newTrapPrice;
            trap.dexPrice = dexPrice;
            
            eventEmitter.emit('signal:update_trap', {
                symbol,
                newTrapPrice,
                newDexPrice: dexPrice
            });
            return;
        }

        // 3. Обычное обновление
        if (newTrapPrice !== trap.trapPrice) {
            trap.trapPrice = newTrapPrice;
            trap.dexPrice = dexPrice;
            trap.lastDexPrice = dexPrice;
            trap.lastCexPrice = cexPrice;
            
            eventEmitter.emit('signal:update_trap', {
                symbol,
                newTrapPrice,
                newDexPrice: dexPrice
            });
            
            const direction = newTrapPrice > trap.trapPrice ? 'поднята' : 'опущена';
            logger.debug(`📉📈 Ловушка ${symbol} ${direction} до $${newTrapPrice}`);
        }
    }

    cancelTrap(symbol, trap, reason) {
        eventEmitter.emit('signal:cancel_trap', { symbol });
        this.activeTraps.delete(symbol);
        logger.info(`❌ Ловушка ${symbol} отменена: ${reason}`);
    }

    // ==================== АКТИВНЫЕ ПОЗИЦИИ ====================

    updateActivePosition(symbol, position, dexPrice, cexPrice) {
        const newTakeProfit = this.calculateTakeProfitPrice(
            position.entryPrice, dexPrice, cexPrice, position.config.takeProfitRecoveryPercent
        );
        
        const changePercent = Math.abs((newTakeProfit - position.takeProfitPrice) / position.takeProfitPrice) * 100;
        
        if (changePercent > 0.5) {
            position.takeProfitPrice = newTakeProfit;
            
            eventEmitter.emit('signal:update_take_profit', {
                symbol,
                newTakeProfit,
                size: position.size
            });
            
            logger.debug(`🔄 Тейк ${symbol} скорректирован: $${newTakeProfit}`);
        }
    }

    updatePartialPosition(symbol, partialPos, dexPrice, cexPrice) {
        const newTakeProfit = this.calculateTakeProfitPrice(
            partialPos.entryPrice, dexPrice, cexPrice, partialPos.config.takeProfitRecoveryPercent
        );
        
        const changePercent = Math.abs((newTakeProfit - partialPos.takeProfitPrice) / partialPos.takeProfitPrice) * 100;
        
        if (changePercent > 0.5) {
            partialPos.takeProfitPrice = newTakeProfit;
            
            eventEmitter.emit('signal:update_take_profit', {
                symbol,
                newTakeProfit,
                size: partialPos.filledSize
            });
            
            logger.debug(`🔄 Тейк частичной позиции ${symbol} скорректирован: $${newTakeProfit}`);
        }
    }

    // ==================== ОБРАБОТКА СОБЫТИЙ ОТ EXECUTOR ====================

    onPositionOpened({ symbol, entryPrice, dexPrice, size }) {
        const config = this.getTokenConfig(symbol);
        const currentDexPrice = this.getLatestDexPrice(symbol);
        const currentCexPrice = this.getLatestCexPrice(symbol);
        const takeProfitPrice = this.calculateTakeProfitPrice(
            entryPrice, currentDexPrice, currentCexPrice, config.takeProfitRecoveryPercent
        );
        
        this.activePositions.set(symbol, {
            symbol,
            entryPrice,
            size,
            takeProfitPrice,
            config,
            openedAt: Date.now()
        });
        
        // Удаляем ловушку, если была
        if (this.activeTraps.has(symbol)) {
            this.activeTraps.delete(symbol);
        }
        
        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit: takeProfitPrice,
            size
        });
        
        logger.info(`🎯 ПОЗИЦИЯ ОТКРЫТА ${symbol}: $${entryPrice}, размер ${size} USDT, тейк $${takeProfitPrice}`);
        
        setTimeout(() => this.checkPositionTimeout(symbol), this.positionTimeoutMs);
    }

    onPartialPositionOpened({ symbol, entryPrice, dexPrice, filledSize, remainingSize, totalSize }) {
        const config = this.getTokenConfig(symbol);
        const currentDexPrice = this.getLatestDexPrice(symbol);
        const currentCexPrice = this.getLatestCexPrice(symbol);
        const takeProfitPrice = this.calculateTakeProfitPrice(
            entryPrice, currentDexPrice, currentCexPrice, config.takeProfitRecoveryPercent
        );
        
        this.partialPositions.set(symbol, {
            symbol,
            entryPrice,
            filledSize,
            remainingSize,
            totalSize,
            takeProfitPrice,
            config,
            openedAt: Date.now()
        });
        
        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit: takeProfitPrice,
            size: filledSize
        });
        
        logger.info(`📊 ЧАСТИЧНАЯ ПОЗИЦИЯ ${symbol}: ${filledSize} USDT по $${entryPrice}, тейк $${takeProfitPrice}, остаток ловушки ${remainingSize} USDT`);
    }

    onPositionClosed({ symbol, reason, profitPercent, filledSize }) {
        const position = this.activePositions.get(symbol);
        if (position) {
            logger.info(`🔒 ПОЗИЦИЯ ЗАКРЫТА ${symbol}: ${reason} (${profitPercent > 0 ? '+' : ''}${profitPercent?.toFixed(2)}%)`);
            this.activePositions.delete(symbol);
        }
    }

    onPartialPositionClosed({ symbol, filledSize, remainingSize, profitPercent }) {
        const partialPos = this.partialPositions.get(symbol);
        if (partialPos) {
            const newFilledSize = partialPos.filledSize - filledSize;
            
            if (newFilledSize <= 0) {
                this.partialPositions.delete(symbol);
                logger.info(`🔒 ЧАСТИЧНАЯ ПОЗИЦИЯ ${symbol} ПОЛНОСТЬЮ ЗАКРЫТА: прибыль ${profitPercent > 0 ? '+' : ''}${profitPercent?.toFixed(2)}%`);
            } else {
                partialPos.filledSize = newFilledSize;
                logger.info(`🔒 ЧАСТИЧНАЯ ПОЗИЦИЯ ${symbol} ЧАСТИЧНО ЗАКРЫТА: закрыто ${filledSize} USDT, осталось ${newFilledSize} USDT`);
            }
        }
    }

    onTrapCancelled({ symbol, reason }) {
        if (this.activeTraps.has(symbol)) {
            this.activeTraps.delete(symbol);
            logger.info(`❌ Ловушка ${symbol} отменена (событие): ${reason}`);
        }
    }

    onExecutorError({ symbol, error, action }) {
        logger.error(`⚠️ ОШИБКА EXECUTOR ${symbol}: ${action} — ${error}`);
        
        // При критической ошибке отменяем ловушку
        if (this.activeTraps.has(symbol) && action === 'create_trap') {
            this.cancelTrap(symbol, this.activeTraps.get(symbol), 'executor_error');
        }
    }

    checkPositionTimeout(symbol) {
        const position = this.activePositions.get(symbol);
        if (!position) return;
        
        const currentCexPrice = this.getLatestCexPrice(symbol);
        if (!currentCexPrice) return;
        
        const profitPercent = ((currentCexPrice - position.entryPrice) / position.entryPrice) * 100;
        
        logger.warn(`⏰ ТАЙМАУТ ПОЗИЦИИ ${symbol} (3ч): профит ${profitPercent.toFixed(2)}%`);
        
        eventEmitter.emit('signal:close_position', {
            symbol,
            size: position.size,
            price: currentCexPrice,
            reason: 'timeout'
        });
    }
}

module.exports = new Analyzer();
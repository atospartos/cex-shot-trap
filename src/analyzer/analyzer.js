// src/analytics/analyzer.js
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class Analyzer {
    constructor() {
        this.activeTraps = new Map();
        this.priceHistory = new Map();
        this.lastProcessedPrices = new Map();
        this.tokensConfig = new Map(); // symbol -> strategy config

        // Базовая конфигурация (по умолчанию)
        this.defaultConfig = {
            trapOffsetPercent: 10,
            takeProfitRecoveryPercent: 70,
            positionSize: 5,
            maxConsecutiveLosses: 3,
            cooldownMinutes: 60
        };

        this.setupListeners();
        this.loadTokensConfig();
        
        logger.info('🔍 Анализатор (ловля прострелов) инициализирован');
        logger.info(`   Индивидуальные настройки для ${this.tokensConfig.size} токенов`);
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
                        cooldownMinutes: token.strategy.cooldownMinutes || this.defaultConfig.cooldownMinutes
                    });
                    
                    logger.info(`   ${token.symbol}: отступ ${this.tokensConfig.get(token.symbol).trapOffsetPercent}%, тейк ${this.tokensConfig.get(token.symbol).takeProfitRecoveryPercent}%, размер $${this.tokensConfig.get(token.symbol).positionSize}`);
                } else {
                    // Используем настройки по умолчанию
                    this.tokensConfig.set(token.symbol, { ...this.defaultConfig });
                }
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки конфигурации токенов: ${error.message}`);
        }
    }

    getTokenConfig(symbol) {
        return this.tokensConfig.get(symbol) || this.defaultConfig;
    }

    setupListeners() {
        eventEmitter.on('data:ready', this.processData.bind(this));
        eventEmitter.on('position:opened', this.onPositionOpened.bind(this));
        eventEmitter.on('position:closed', this.onPositionClosed.bind(this));
    }

    updatePriceHistory(symbol, dexPrice, cexPrice, timestamp) {
        if (!this.priceHistory.has(symbol)) {
            this.priceHistory.set(symbol, { dex: [], cex: [] });
        }

        const history = this.priceHistory.get(symbol);
        history.dex.push({ price: dexPrice, timestamp });
        history.cex.push({ price: cexPrice, timestamp });

        const cutoff = timestamp - (60 * 60 * 1000);
        history.dex = history.dex.filter(h => h.timestamp > cutoff);
        history.cex = history.cex.filter(h => h.timestamp > cutoff);
    }

    getLatestCexPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        if (!history || history.cex.length === 0) return null;
        return history.cex[history.cex.length - 1].price;
    }

    calculateTakeProfitPrice(entryPrice, currentDexPrice, currentCexPrice, recoveryPercent) {
        if (currentDexPrice < currentCexPrice) {
            return currentCexPrice;
        }
        const fullGap = currentDexPrice - entryPrice;
        const recoveryAmount = fullGap * (recoveryPercent / 100);
        return entryPrice + recoveryAmount;
    }

    processData({ symbol, dexPrice, cexPrice, timestamp }) {
        if (!dexPrice || !cexPrice) return;

        this.updatePriceHistory(symbol, dexPrice, cexPrice, timestamp);

        const activeTrap = this.activeTraps.get(symbol);
        const lastPrices = this.lastProcessedPrices.get(symbol);

        this.lastProcessedPrices.set(symbol, { dexPrice, cexPrice, timestamp });

        if (activeTrap) {
            this.updateActiveTrap(symbol, activeTrap, dexPrice, cexPrice, timestamp, lastPrices);
        } else {
            this.createTrap(symbol, dexPrice, cexPrice, timestamp);
        }
    }

    createTrap(symbol, dexPrice, cexPrice, timestamp) {
        const config = this.getTokenConfig(symbol);
        const trapPrice = dexPrice * (1 - config.trapOffsetPercent / 100);
        const takeProfitPrice = this.calculateTakeProfitPrice(
            trapPrice, dexPrice, cexPrice, config.takeProfitRecoveryPercent
        );

        const trap = {
            id: `${symbol}_${timestamp}`,
            symbol,
            createdAt: timestamp,
            dexPrice: dexPrice,
            cexPrice: cexPrice,
            originalDexPrice: dexPrice,
            originalCexPrice: cexPrice,
            trapPrice: trapPrice,
            takeProfitPrice: takeProfitPrice,
            lastDexPrice: dexPrice,
            lastCexPrice: cexPrice,
            status: 'pending',
            remainingSize: config.positionSize,
            totalSize: config.positionSize,
            config: config
        };

        this.activeTraps.set(symbol, trap);

        logger.debug(`📌 ЛОВУШКА ${symbol}`, {
            dexPrice: `$${dexPrice.toFixed(6)}`,
            cexPrice: `$${cexPrice.toFixed(6)}`,
            trapOffset: `${config.trapOffsetPercent}%`,
            trapPrice: `$${trapPrice.toFixed(6)}`,
            takeProfit: `$${takeProfitPrice.toFixed(6)}`,
            size: `${config.positionSize} USDT`
        });

        eventEmitter.emit('signal:create_trap', {
            symbol,
            dexPrice,
            trapPrice,
            size: config.positionSize
        });
    }

    updateActiveTrap(symbol, trap, dexPrice, cexPrice, timestamp, lastPrices) {
        const dexRising = dexPrice > trap.lastDexPrice;
        const dexFalling = dexPrice < trap.lastDexPrice;
        const cexRising = cexPrice > trap.lastCexPrice;
        const cexFalling = cexPrice < trap.lastCexPrice;
        const cexStable = Math.abs(cexPrice - trap.lastCexPrice) < 0.00001;
        
        const isNotExecuted = trap.status === 'pending';
        const isExecuted = trap.status === 'active' || trap.remainingSize < trap.totalSize;

        // DEX РАСТЕТ
        if (dexRising) {
            if (cexStable && isNotExecuted) {
                logger.info(`📈 DEX ↑ CEX → | НЕ ИСПОЛНЕН | ВХОД ПО CEX (раскорелляция) для ${symbol}`);
                this.decouplingEntry(symbol, trap, dexPrice, cexPrice);
                return;
            }
            
            if (cexRising && isNotExecuted) {
                logger.info(`🔄 DEX ↑ CEX ↑ | НЕ ИСПОЛНЕН | КОРРЕКТИРОВКА ЛОВУШКИ для ${symbol}`);
                this.adjustTrap(symbol, trap, dexPrice, cexPrice);
                return;
            }
            
            if (isExecuted) {
                logger.info(`🔄 DEX ↑ | ИСПОЛНЕН | КОРРЕКТИРОВКА ТЕЙКА + ПЕРЕСТАНОВКА ЛОВУШКИ для ${symbol}`);
                this.adjustTakeProfit(symbol, trap, dexPrice, cexPrice);
                if (trap.remainingSize > 0) {
                    this.adjustTrap(symbol, trap, dexPrice, cexPrice);
                }
                return;
            }
        }
        
        // DEX ПАДАЕТ
        if (dexFalling) {
            if (isNotExecuted) {
                logger.info(`📉 DEX ↓ | НЕ ИСПОЛНЕН | УБИРАЕМ ЛОВУШКУ для ${symbol}`);
                this.cancelTrap(symbol, trap);
                return;
            }
            
            if (isExecuted) {
                logger.info(`📉 DEX ↓ | ИСПОЛНЕН | УБИРАЕМ ЛОВУШКУ + КОРРЕКТИРОВКА ТЕЙКА для ${symbol}`);
                if (trap.remainingSize > 0) {
                    this.cancelTrap(symbol, trap);
                }
                this.adjustTakeProfit(symbol, trap, dexPrice, cexPrice);
                return;
            }
        }
        
        trap.lastDexPrice = dexPrice;
        trap.lastCexPrice = cexPrice;
    }

    decouplingEntry(symbol, trap, dexPrice, cexPrice) {
        eventEmitter.emit('signal:cancel_trap', { symbol });
        
        eventEmitter.emit('signal:decoupling_entry', {
            symbol,
            dexPrice,
            cexPrice,
            size: trap.totalSize
        });
        
        this.activeTraps.delete(symbol);
    }

    adjustTrap(symbol, trap, dexPrice, cexPrice) {
        const config = this.getTokenConfig(symbol);
        const newTrapPrice = dexPrice * (1 - config.trapOffsetPercent / 100);
        
        trap.trapPrice = newTrapPrice;
        trap.dexPrice = dexPrice;
        
        eventEmitter.emit('signal:update_trap', {
            symbol,
            newTrapPrice,
            newDexPrice: dexPrice
        });
    }

    adjustTakeProfit(symbol, trap, dexPrice, cexPrice) {
        const config = this.getTokenConfig(symbol);
        const entryPrice = trap.actualEntryPrice || trap.trapPrice;
        const newTakeProfit = this.calculateTakeProfitPrice(
            entryPrice, dexPrice, cexPrice, config.takeProfitRecoveryPercent
        );
        
        trap.takeProfitPrice = newTakeProfit;
        
        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit,
            dexPrice,
            size: trap.totalSize - (trap.remainingSize || 0)
        });
    }

    cancelTrap(symbol, trap) {
        eventEmitter.emit('signal:cancel_trap', { symbol });
        this.activeTraps.delete(symbol);
    }

    onPositionOpened({ symbol, entryPrice, dexPrice }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap || trap.status !== 'pending') return;

        trap.status = 'active';
        trap.actualEntryPrice = entryPrice;
        trap.activatedAt = Date.now();
        trap.remainingSize = trap.totalSize;
        
        const currentCexPrice = this.getLatestCexPrice(symbol);
        const config = this.getTokenConfig(symbol);
        const currentTakeProfit = this.calculateTakeProfitPrice(
            entryPrice, dexPrice, currentCexPrice, config.takeProfitRecoveryPercent
        );
        trap.takeProfitPrice = currentTakeProfit;

        logger.info(`🎯 ЛОВУШКА СРАБОТАЛА ${symbol}`, {
            entryPrice: `$${entryPrice.toFixed(6)}`,
            dexPrice: `$${dexPrice.toFixed(6)}`,
            takeProfit: `$${currentTakeProfit.toFixed(6)}`,
            size: `${trap.totalSize} USDT`
        });

        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit: currentTakeProfit,
            size: trap.totalSize
        });

        setTimeout(() => {
            this.checkActiveTimeout(symbol);
        }, this.config.maxActiveTimeMs);
    }

    checkActiveTimeout(symbol) {
        const trap = this.activeTraps.get(symbol);
        if (!trap || trap.status !== 'active') return;

        const currentCexPrice = this.getLatestCexPrice(symbol);
        if (!currentCexPrice) return;

        const profitPercent = ((currentCexPrice - trap.actualEntryPrice) / trap.actualEntryPrice) * 100;

        logger.warn(`⏰ ТАЙМАУТ ${symbol} (3 часа)`, {
            entryPrice: `$${trap.actualEntryPrice.toFixed(6)}`,
            currentPrice: `$${currentCexPrice.toFixed(6)}`,
            profitPercent: `${profitPercent.toFixed(2)}%`
        });

        eventEmitter.emit('signal:close_position', {
            symbol,
            size: trap.totalSize,
            price: currentCexPrice,
            reason: 'timeout'
        });

        this.activeTraps.delete(symbol);
    }

    onPositionClosed({ symbol, reason, profitPercent }) {
        const trap = this.activeTraps.get(symbol);
        if (trap) {
            logger.info(`🔒 ПОЗИЦИЯ ЗАКРЫТА ${symbol}: ${reason} (${profitPercent > 0 ? '+' : ''}${profitPercent?.toFixed(2)}%)`);
            this.activeTraps.delete(symbol);
        }
    }
}

module.exports = new Analyzer();
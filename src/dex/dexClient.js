const logger = require('../core/logger');

class DexClient {
    /**
     * Получение данных для токена с анализом топовых пулов
     */
    async fetchTokenData(tokenAddress) {
        try {
            const allPools = await this.searchByExactAddress(tokenAddress);

            if (!allPools || allPools.length === 0) {
                logger.warn(`⚠️ Нет пулов по адресу ${tokenAddress}`);
                return null;
            }

            const bestPools = this._getBestLiquidityPools(allPools);

            if (bestPools.length === 0) {
                logger.debug(`⚠️ Нет пулов с ликвидностью`);
                return null;
            }

            if (bestPools.length > 1) {
                logger.debug(`📊 Дополнительные пулы:`,
                    bestPools.slice(1).map(p => `${p.dexId} ${p.baseToken}/${p.quoteToken} ($${p.liquidityUsd})`)
                );
            }

            return bestPools;

        } catch (error) {
            logger.error(`❌ Ошибка DEX:`, { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Точный поиск по адресу
     */
    async searchByExactAddress(tokenAddress) {
        try {
            logger.debug(`🔍 Точный поиск по адресу: ${tokenAddress}`);

            const axios = require('axios');
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/search?q=${tokenAddress}`,
                { timeout: 2000 }
            );

            if (response.data && response.data.pairs) {
                logger.debug(`✅ Найдено ${response.data.pairs.length} пулов по адресу ${tokenAddress}`);
                return this._normalizePools(response.data.pairs);
            }

            return [];

        } catch (error) {
            logger.error(`Ошибка поиска по адресу ${tokenAddress}:`, { error: error.message });
            return [];
        }
    }

    /**
     * Выбор лучших пулов по ликвидности
     */
    _getBestLiquidityPools(pools) {
        if (!pools || pools.length === 0) return [];

        const poolsWithLiquidity = pools.filter(p => p.liquidityUsd > 20000);

        if (poolsWithLiquidity.length === 0) {
            logger.warn(`⚠️ Все пулы имеют малую ликвидность`);
            return [];
        }

        return poolsWithLiquidity
            .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
            .slice(0, 1);
    }

    /**
    * Нормализация пулов
    */
    _normalizePools(pools) {
        if (!Array.isArray(pools)) return [];

        return pools.map(pool => {
            // Парсим цену с учетом научной нотации
            let priceUsd = 0;
            if (pool.priceUsd !== undefined && pool.priceUsd !== null) {
                if (typeof pool.priceUsd === 'string') {
                    priceUsd = parseFloat(pool.priceUsd);
                } else {
                    priceUsd = parseFloat(pool.priceUsd) || 0;
                }
            }

            return {
                pairAddress: pool.pairAddress,
                dexId: pool.dexId,
                chainId: pool.chainId,
                url: pool.url,
                baseToken: pool.baseToken?.symbol,
                quoteToken: pool.quoteToken?.symbol,
                priceUsd: priceUsd,
                liquidityUsd: pool.liquidity?.usd || 0,
                volume24h: pool.volume?.h24 || 0,
                priceChange24h: pool.priceChange?.h24 || 0,
                txns24h: {
                    buys: pool.txns?.h24?.buys || 0,
                    sells: pool.txns?.h24?.sells || 0,
                    total: (pool.txns?.h24?.buys || 0) + (pool.txns?.h24?.sells || 0)
                },
                pairCreatedAt: pool.pairCreatedAt
                    ? new Date(pool.pairCreatedAt * 1000).toISOString()
                    : null
            };
        });
    }
}

module.exports = new DexClient();
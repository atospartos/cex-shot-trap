const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

class ContractResolver {
    constructor(options = {}) {
        this.baseURL = 'https://api.mexc.com/api/v3';
        this.delayMs = options.delayMs || 333;
        this.timeout = options.timeout || 6000;
        this.minLiquidityUSD = options.minLiquidityUSD || 5000; // Минимальная ликвидность 5000$
        this.client = null;
        this.requestCount = 0;
        this.maxRequestsPerClient = 1000;
        this.createClient();
    }

    static readTokensFromFile(filePath) {
        const fullPath = path.resolve(filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Файл ${fullPath} не найден`);
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const data = JSON.parse(content);

        let tokens = [];
        if (data.length > 0 && typeof data[0] === 'object' && data[0].symbol) {
            tokens = data.map(item => item.symbol);
        } else if (data.length > 0 && typeof data[0] === 'string') {
            tokens = data;
        } else {
            tokens = data.map(line => line.symbol || line);
        }

        logger.info(`📖 Прочитано ${tokens.length} токенов из ${fullPath}`);

        if (tokens.length === 0) {
            throw new Error(`Файл ${fullPath} не содержит токенов`);
        }

        return tokens;
    }

    static readExistingTokens(filePath) {
        const fullPath = path.resolve(filePath);

        if (!fs.existsSync(fullPath)) {
            return [];
        }

        try {
            delete require.cache[require.resolve(fullPath)];
            const tokens = require(fullPath);
            return Array.isArray(tokens) ? tokens : [];
        } catch (error) {
            logger.warn(`⚠️ Не удалось прочитать ${fullPath}: ${error.message}`);
            return [];
        }
    }

    createClient() {
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        this.requestCount = 0;
    }

    checkAndRotateClient() {
        if (this.requestCount >= this.maxRequestsPerClient) {
            logger.debug(`   🔄 Пересоздание клиента (${this.requestCount} запросов)`);
            this.createClient();
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async fetchCurrencyInfo(currency) {
        this.checkAndRotateClient();

        try {
            const response = await this.client.get('/exchangeInfo', {
                params: { symbol: `${currency}USDT` }
            });
            this.requestCount++;

            if (response.data.symbols && response.data.symbols.length > 0) {
                const symbolInfo = response.data.symbols[0];

                if (symbolInfo.status === 'TRADING' || symbolInfo.status === 1 || symbolInfo.status === '1') {
                    const poolData = await this.extractContractAddress(currency, symbolInfo);

                    if (poolData && poolData.address && poolData.liquidityUSD >= this.minLiquidityUSD) {
                        return {
                            currency: currency,
                            contractAddress: poolData.address,
                            chainId: poolData.chainId,
                            dexId: poolData.dexId,
                            liquidityUSD: poolData.liquidityUSD || 0,
                            volume24h: poolData.volume24h || 0,
                            priceUSD: poolData.priceUSD || 0,
                            marketCap: poolData.marketCap || 0
                        };
                    } else if (poolData && poolData.address && poolData.liquidityUSD < this.minLiquidityUSD) {
                        return { error: `low_liquidity_${poolData.liquidityUSD}`, currency };
                    } else {
                        return { error: 'no_contract_address', currency };
                    }
                } else {
                    return { error: 'trading_disabled', currency };
                }
            }
            return { error: 'not_found', currency };
        } catch (error) {
            if (error.response?.status === 404) {
                return { error: 'not_found', currency };
            }
            if (error.response?.status === 429) {
                logger.warn(`   ⚠️ Rate limit для ${currency}, ждем...`);
                await this.delay(2000);
                return this.fetchCurrencyInfo(currency);
            }
            return { error: error.message, currency };
        }
    }

    async fetchDEXData(contractAddress) {
        try {
            // Запрос к DEX API для получения данных о пуле
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/search?q=${contractAddress}`,
                { timeout: 2000 }
            );

            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                // Находим пул с наибольшей ликвидностью
                const bestPool = response.data.pairs.reduce((best, current) => {
                    const bestLiquidity = best?.liquidity?.usd || 0;
                    const currentLiquidity = current?.liquidity?.usd || 0;
                    return currentLiquidity > bestLiquidity ? current : best;
                }, null);

                if (bestPool && bestPool.liquidity && bestPool.liquidity.usd >= this.minLiquidityUSD) {
                    return {
                        chainId: bestPool.chainId,
                        dexId: bestPool.dexId,
                        liquidityUSD: bestPool.liquidity?.usd || 0,
                        volume24h: bestPool.volume?.h24 || bestPool.volume?.day || 0,
                        priceUSD: parseFloat(bestPool.priceUsd) || 0,
                        marketCap: bestPool.marketCap || 0,
                        pairAddress: bestPool.pairAddress,
                        baseToken: bestPool.baseToken,
                        quoteToken: bestPool.quoteToken
                    };
                }
            }
            return null;
        } catch (error) {
            logger.error(`   ❌ Ошибка при запросе DEX API: ${error.message}`);
            return null;
        }
    }

    async extractContractAddress(symbol, symbolInfo) {
        const contractAddress = symbolInfo.contractAddress ||
            symbolInfo.contractAddresses?.BSC ||
            symbolInfo.contractAddresses?.ETH ||
            symbolInfo.baseAssetContractAddress;

        if (!contractAddress) {
            logger.debug(`   ⚠️ Нет адреса контракта для ${symbol}`);
            return null;
        }

        logger.info(`\n Address: ${contractAddress}`);

        try {
            // Получаем данные о пулах с DEX API
            const dexData = await this.fetchDEXData(contractAddress);

            // Проверяем наличие DEX пулов и ликвидности
            if (!dexData) {
                logger.info(`⚠️ Нет DEX пулов для ${symbol}`);
                return {
                    address: contractAddress,
                    chainId: null,
                    dexId: null,
                    liquidityUSD: 0,
                    volume24h: 0,
                    priceUSD: 0,
                    marketCap: 0
                };
            }

            if (dexData.liquidityUSD < this.minLiquidityUSD) {
                logger.info(`⚠️ Недостаточная ликвидность для ${symbol}: $${dexData.liquidityUSD.toLocaleString()} (мин. $${this.minLiquidityUSD.toLocaleString()})`);
                return {
                    address: contractAddress,
                    chainId: dexData.chainId,
                    dexId: dexData.dexId,
                    liquidityUSD: dexData.liquidityUSD,
                    volume24h: dexData.volume24h,
                    priceUSD: dexData.priceUSD,
                    marketCap: dexData.marketCap
                };
            }

            logger.info(`\n 🔗 Сеть: ${dexData.chainId} (${dexData.dexId})`);
            logger.info(` 💰 Ликвидность: $${dexData.liquidityUSD.toLocaleString()} USD`);
            logger.info(` 📊 Объем 24ч: $${dexData.volume24h.toLocaleString()} USD`);
            logger.info(` 💵 Цена: $${dexData.priceUSD.toFixed(8)} USD`);
            if (dexData.marketCap > 0) {
                logger.info(` 🏦 Market Cap: $${dexData.marketCap.toLocaleString()} USD`);
            }

            return {
                address: contractAddress,
                chainId: dexData.chainId,
                dexId: dexData.dexId,
                liquidityUSD: dexData.liquidityUSD,
                volume24h: dexData.volume24h,
                priceUSD: dexData.priceUSD,
                marketCap: dexData.marketCap
            };
        } catch (error) {
            logger.error(`   ❌ Ошибка при получении данных DEX для ${symbol}: ${error.message}`);
            return {
                address: contractAddress,
                chainId: null,
                dexId: null,
                liquidityUSD: 0,
                volume24h: 0,
                priceUSD: 0,
                marketCap: 0
            };
        }
    }

    async getContractAddress(symbol) {
        const currencyInfo = await this.fetchCurrencyInfo(symbol);

        if (currencyInfo.error) {
            return {
                symbol,
                address: null,
                chainId: null,
                dexId: null,
                liquidityUSD: 0,
                volume24h: 0,
                priceUSD: 0,
                marketCap: 0,
                error: currencyInfo.error
            };
        }

        return {
            symbol,
            address: currencyInfo.contractAddress || null,
            chainId: currencyInfo.chainId || null,
            dexId: currencyInfo.dexId || null,
            liquidityUSD: currencyInfo.liquidityUSD || 0,
            volume24h: currencyInfo.volume24h || 0,
            priceUSD: currencyInfo.priceUSD || 0,
            marketCap: currencyInfo.marketCap || 0,
            error: null
        };
    }

    static formatTokenEntry(symbol, address, chainId, dexId, liquidityUSD, volume24h, priceUSD, marketCap) {
        if (!address) {
            return null;
        }

        const entry = {
            symbol: symbol,
            address: address,
            chainId: chainId || 'unknown',
            dexId: dexId || 'unknown',
            liquidityUSD: Math.round(liquidityUSD * 100) / 100,
            volume24hUSD: Math.round(volume24h * 100) / 100,
            priceUSD: parseFloat(priceUSD).toFixed(12)
        };

        if (marketCap > 0) {
            entry.marketCapUSD = Math.round(marketCap * 100) / 100;
        }

        return entry;
    }

    async updateFromFile(inputFile, outputPath, minLiquidityUSD = 5000) {
        // Устанавливаем минимальную ликвидность
        this.minLiquidityUSD = minLiquidityUSD;

        const newTokensList = ContractResolver.readTokensFromFile(inputFile);
        const existingTokens = ContractResolver.readExistingTokens(outputPath);
        const existingSymbols = existingTokens.map(t => t.symbol);

        const newSymbols = newTokensList.filter(s => !existingSymbols.includes(s));

        logger.info(`\n🔍 Обновление из файла: ${inputFile}`);
        logger.info(`📊 Существующих токенов: ${existingSymbols.length}`);
        logger.info(`📊 Всего в файле: ${newTokensList.length}`);
        logger.info(`🆕 Новых для добавления: ${newSymbols.length}`);
        logger.info(`💰 Минимальная ликвидность: $${this.minLiquidityUSD.toLocaleString()} USD`);
        logger.info(`⚠️ Токены с ликвидностью ниже минимума НЕ будут добавлены в файл`);

        if (newSymbols.length === 0) {
            logger.info('\n✅ Файл уже актуален, новых токенов нет');
            return existingTokens;
        }

        const newResults = [];
        const skippedTokens = [];

        logger.info(`\n🔍 Сбор адресов для новых токенов`);
        logger.info('='.repeat(65));

        for (let i = 0; i < newSymbols.length; i++) {
            const symbol = newSymbols[i];
            process.stdout.write(`\n[${i + 1}/${newSymbols.length}] ${symbol}... `);

            const result = await this.getContractAddress(symbol);

            // Проверяем все условия для записи в файл
            const hasAddress = result.address && result.address !== null;
            const hasDEXPools = result.dexId && result.dexId !== 'unknown' && result.dexId !== null;
            const hasEnoughLiquidity = result.liquidityUSD >= this.minLiquidityUSD;

            if (hasAddress && hasDEXPools && hasEnoughLiquidity) {
                newResults.push(result);

                // Форматируем вывод
                let successMsg = `✅ ${result.symbol}`;
                successMsg += ` | Сеть: ${result.chainId || 'unknown'}`;
                successMsg += ` | DEX: ${result.dexId || 'unknown'}`;
                successMsg += ` | 💰 $${result.liquidityUSD.toLocaleString()}`;
                successMsg += ` | 📊 $${result.volume24h.toLocaleString()}`;
                successMsg += ` | 💵 $${parseFloat(result.priceUSD).toFixed(6)}`;

                logger.info(successMsg);
            } else {
                // Собираем информацию о причине пропуска
                const skipReasons = [];
                if (!hasAddress) skipReasons.push('нет адреса');
                if (!hasDEXPools) skipReasons.push('нет DEX пулов');
                if (!hasEnoughLiquidity && result.liquidityUSD > 0) skipReasons.push(`ликвидность $${result.liquidityUSD.toLocaleString()} < $${this.minLiquidityUSD.toLocaleString()}`);
                else if (!hasEnoughLiquidity && result.liquidityUSD === 0) skipReasons.push('нет ликвидности');

                const reason = skipReasons.join(', ');
                skippedTokens.push({ symbol: result.symbol, reason });

                if (result.error === 'not_found') {
                    logger.info(' ⚠️ не найден на MEXC');
                } else if (result.error === 'trading_disabled') {
                    logger.info(' ⚠️ торговля отключена');
                } else if (result.error === 'no_contract_address') {
                    logger.info(' ⚠️ нет адреса контракта');
                } else if (result.error?.startsWith('low_liquidity')) {
                    const liquidity = result.error.split('_')[2];
                    logger.info(` ⚠️ ликвидность $${parseFloat(liquidity).toLocaleString()} < $${this.minLiquidityUSD.toLocaleString()}`);
                } else {
                    logger.info(` ⚠️ ${reason || 'не соответствует критериям'}`);
                }
            }

            if (i < newSymbols.length - 1) {
                await this.delay(this.delayMs);
            }
        }

        // Показываем статистику пропущенных токенов
        if (skippedTokens.length > 0) {
            logger.info('\n' + '='.repeat(65));
            logger.info(`⚠️ Пропущено токенов (не добавлены в файл): ${skippedTokens.length}`);

            // Группируем по причинам
            const reasonsMap = new Map();
            for (const token of skippedTokens) {
                reasonsMap.set(token.reason, (reasonsMap.get(token.reason) || 0) + 1);
            }

            logger.info('📋 Причины пропуска:');
            for (const [reason, count] of reasonsMap) {
                logger.info(`   - ${reason}: ${count} токенов`);
            }
        }

        // Добавляем только прошедшие фильтрацию токены
        const allTokens = [...existingTokens];

        for (const result of newResults) {
            if (result.address) {
                allTokens.push({
                    symbol: result.symbol,
                    address: result.address,
                    chainId: result.chainId || 'unknown',
                    dexId: result.dexId || 'unknown',
                    liquidityUSD: result.liquidityUSD || 0,
                    volume24hUSD: result.volume24h || 0,
                    priceUSD: result.priceUSD || 0,
                    marketCapUSD: result.marketCap || 0
                });
            }
        }

        // Удаляем дубликаты
        const uniqueTokens = [];
        const seenSymbols = new Set();
        for (const token of allTokens) {
            if (!seenSymbols.has(token.symbol)) {
                seenSymbols.add(token.symbol);
                uniqueTokens.push(token);
            }
        }

        uniqueTokens.sort((a, b) => a.symbol.localeCompare(b.symbol));

        // Форматируем как валидный JSON массив
        const formattedEntries = uniqueTokens
            .map(t => ContractResolver.formatTokenEntry(
                t.symbol, t.address, t.chainId, t.dexId,
                t.liquidityUSD, t.volume24hUSD, t.priceUSD, t.marketCapUSD
            ))
            .filter(entry => entry !== null);

        // Создаем валидный JSON
        const fileContent = JSON.stringify(formattedEntries, null, 2);

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, fileContent, 'utf-8');

        const withAddresses = newResults.filter(r => r.address).length;
        const avgLiquidity = newResults.length > 0
            ? newResults.reduce((sum, r) => sum + r.liquidityUSD, 0) / newResults.length
            : 0;

        logger.info('\n' + '='.repeat(65));
        logger.info(`✅ Файл обновлен: ${outputPath}`);
        logger.info(`📊 Всего токенов в файле: ${uniqueTokens.length}`);
        logger.info(`🆕 Добавлено новых: ${newResults.length} (из ${newSymbols.length} проверенных)`);
        logger.info(`⚠️ Пропущено: ${newSymbols.length - newResults.length}`);

        if (newResults.length > 0) {
            logger.info(`💰 Средняя ликвидность добавленных: $${avgLiquidity.toLocaleString()} USD`);
            logger.info(`📈 Общая ликвидность: $${newResults.reduce((sum, r) => sum + r.liquidityUSD, 0).toLocaleString()} USD`);
            logger.info(`📊 Общий объем 24ч: $${newResults.reduce((sum, r) => sum + r.volume24h, 0).toLocaleString()} USD`);
        }

        return uniqueTokens;
    }
}

module.exports = ContractResolver;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dexClient = require('../dex/dexClient');
const logger = require('../core/logger');

class ContractResolver {
    constructor(options = {}) {
        this.baseURL = 'https://api.mexc.com/api/v3';
        this.delayMs = options.delayMs;
        this.timeout = options.timeout;
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

            if (response.data.symbols.length > 0) {
                const symbolInfo = response.data.symbols[0];

                if (symbolInfo.status === '1' || symbolInfo.status === 1) {
                    const pool = await this.extractContractAddress(currency, symbolInfo);
                    return {
                        currency: currency,
                        contractAddress: pool.address,
                        chainId: pool.chainId
                    };
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

    async extractContractAddress(symbol, symbolInfo) {
        const contractAddress = symbolInfo.contractAddress;
        // logger.info(`\n Address: ${contractAddress}`);
        if (!contractAddress) {
            return null;
        }
        const pools = await dexClient.fetchTokenData(contractAddress)
        if (isLiquid.length === 0) {
            logger.info(`⚠️Нет ликвидности на DEX`);
        }

        // Проверяем контракт
        if (pools.length > 0 && contractAddress && contractAddress !== '') {
            return {
                address: contractAddress,
                chainId: pools[0].chainId
            };
        }

        return null;
    }

    async getContractAddress(symbol) {
        const currencyInfo = await this.fetchCurrencyInfo(symbol);

        if (currencyInfo.error) {
            return {
                symbol,
                address: currencyInfo.contractAddress || null,
                error: currencyInfo.error
            };
        }

        return {
            symbol,
            address: currencyInfo.contractAddress || null,
            chainId: currencyInfo.chainId || null
        };
    }

    static formatTokenEntry(symbol, address, chainId) {
        if (!address) {
            return ``;
        }
        return `{ symbol: "${symbol}", address: "${address}", chainId: "${chainId}" }`;
    }

    async updateFromFile(inputFile, outputPath) {
        const newTokensList = ContractResolver.readTokensFromFile(inputFile);
        const existingTokens = ContractResolver.readExistingTokens(outputPath);
        const existingSymbols = existingTokens.map(t => t.symbol);

        const newSymbols = newTokensList.filter(s => !existingSymbols.includes(s));

        logger.info(`\n🔍 Обновление из файла: ${inputFile}`);
        logger.info(`📊 Существующих токенов: ${existingSymbols.length}`);
        logger.info(`📊 Всего в файле: ${newTokensList.length}`);
        logger.info(`🆕 Новых для добавления: ${newSymbols.length}`);

        if (newSymbols.length === 0) {
            logger.info('\n✅ Файл уже актуален, новых токенов нет');
            return existingTokens;
        }

        const newResults = [];

        logger.info(`\n🔍 Сбор адресов для новых токенов`);
        logger.info('='.repeat(55));

        for (let i = 0; i < newSymbols.length; i++) {
            const symbol = newSymbols[i];
            process.stdout.write(`\n[${i + 1}/${newSymbols.length}] ${symbol}... `);

            const result = await this.getContractAddress(symbol);

            if (result.address) {

                newResults.push(result);

                logger.info(` ✅ адрес: ${result.address}`);
            } else if (result.error === 'not_found') {
                logger.debug('⚠️ не найден');
            } else if (result.error === 'trading_disabled') {
                logger.debug('⚠️ торговля отключена');
            } else {
                logger.debug('⚠️ нет адреса контракта');
            }

            if (i < newSymbols.length - 1) {
                await this.delay(this.delayMs);
            }
        }

        const allTokens = [...existingTokens];

        for (const result of newResults) {
            if (result.address) {
                allTokens.push({
                    symbol: result.symbol,
                    address: result.address
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

        const entries = uniqueTokens
            .map(t => ContractResolver.formatTokenEntry(t.symbol, t.address, t.chainId))
            .join(',\n\n');

        const fileContent = `[${entries}]\n`;

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, fileContent);

        const withAddresses = newResults.filter(r => r.address).length;

        logger.info('\n' + '='.repeat(55));
        logger.info(`✅ Файл обновлен: ${outputPath}`);
        logger.info(`📊 Всего токенов: ${uniqueTokens.length}`);
        logger.info(`🆕 Добавлено: ${newSymbols.length} (из них с адресами: ${withAddresses})`);

        return uniqueTokens;
    }
}

module.exports = ContractResolver;
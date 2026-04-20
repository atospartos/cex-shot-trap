const path = require('path');
const ContractResolver = require('./contractResolver');

async function main() {
    const resolver = new ContractResolver({
        delayMs: 300,
        timeout: 3000,
        maxRequestsPerClient: 500
    });

    const txtfile = path.join(process.cwd(), 'data/tokens/pure_tokens.json');
    const jsfile = path.join(process.cwd(), 'data/tokens/tokens.js');

    await resolver.updateFromFile(
        txtfile,
        jsfile
    );
}

main().catch(console.error);
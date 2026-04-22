const path = require('path');
const ContractResolver = require('./contractResolver');

async function main() {
    const resolver = new ContractResolver({
        delayMs: 300,
        timeout: 3000,
        maxRequestsPerClient: 500
    });

    const pure_tokens = path.join(process.cwd(), 'data/tokens/pure_tokens.json');
    const contract_list = path.join(process.cwd(), 'data/tokens/tokens.json');

    await resolver.updateFromFile(
        pure_tokens,
        contract_list
    );
}

main().catch(console.error);
const CHAIN_MAPPING = {
    'solana': {
        pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
        chainId: 'solana:solana',
        name: 'Solana'
    },
    'evm': {
        pattern: /^0x[a-fA-F0-9]{40}$/,
        chainId: 'evm:1',
        name: 'EVM'
    }
};

const KNOWN_ADDRESSES = {};

function detectChainId(address, symbol = null) {
    if (!address || typeof address !== 'string') return null;
    const trimmed = address.trim();
    
    if (KNOWN_ADDRESSES[trimmed.toLowerCase()]) {
        return KNOWN_ADDRESSES[trimmed.toLowerCase()];
    }
    
    if (CHAIN_MAPPING.solana.pattern.test(trimmed)) {
        return CHAIN_MAPPING.solana.chainId;
    }
    
    if (CHAIN_MAPPING.evm.pattern.test(trimmed)) {
        return CHAIN_MAPPING.evm.chainId;
    }
    
    console.warn(`⚠️ Не удалось определить сеть для адреса: ${trimmed.slice(0, 30)}...${symbol ? ` (${symbol})` : ''}`);
    return null;
}

// utils/chainDetector.js
function getChainInfo(chainId) {
    const chains = {
        // EVM сети
        'evm:1': { name: 'Ethereum', type: 'evm' },
        'evm:56': { name: 'BNB Chain', type: 'evm' },
        'evm:137': { name: 'Polygon', type: 'evm' },
        'evm:42161': { name: 'Arbitrum', type: 'evm' },
        'evm:10': { name: 'Optimism', type: 'evm' },
        'evm:8453': { name: 'Base', type: 'evm' },
        'evm:43114': { name: 'Avalanche', type: 'evm' },
        'evm:250': { name: 'Fantom', type: 'evm' },
        'evm:100': { name: 'Gnosis', type: 'evm' },
        'evm:1284': { name: 'Moonbeam', type: 'evm' },
        'evm:1285': { name: 'Moonriver', type: 'evm' },
        'evm:8217': { name: 'Klaytn', type: 'evm' },
        'evm:42220': { name: 'Celo', type: 'evm' },
        'evm:1666600000': { name: 'Harmony', type: 'evm' },
        'evm:288': { name: 'Boba Network', type: 'evm' },
        'evm:25': { name: 'Cronos', type: 'evm' },
        'evm:199': { name: 'BitTorrent', type: 'evm' },
        'evm:106': { name: 'Velas', type: 'evm' },
        'evm:66': { name: 'OKX Chain', type: 'evm' },
        'evm:128': { name: 'Huobi ECO Chain', type: 'evm' },
        'evm:20': { name: 'Elastos', type: 'evm' },
        'evm:40': { name: 'Telos', type: 'evm' },
        'evm:122': { name: 'Fuse', type: 'evm' },
        'evm:2888': { name: 'Metis', type: 'evm' },
        'evm:1088': { name: 'Metis Andromeda', type: 'evm' },
        'evm:59144': { name: 'Linea', type: 'evm' },
        'evm:324': { name: 'zkSync Era', type: 'evm' },
        'evm:1101': { name: 'Polygon zkEVM', type: 'evm' },
        'evm:534352': { name: 'Scroll', type: 'evm' },
        'evm:2222': { name: 'Kava', type: 'evm' },
        'evm:9001': { name: 'Evmos', type: 'evm' },
        'evm:1313161554': { name: 'Aurora', type: 'evm' },
        
        // Non-EVM сети
        'solana:solana': { name: 'Solana', type: 'solana' },
        'ton:ton': { name: 'TON', type: 'ton' },
        'sui:sui': { name: 'Sui', type: 'sui' },
        'aptos:aptos': { name: 'Aptos', type: 'aptos' },
        'near:near': { name: 'NEAR Protocol', type: 'near' },
        'cardano:cardano': { name: 'Cardano', type: 'cardano' },
        'tron:tron': { name: 'TRON', type: 'tron' },
        'alephium:alephium': { name: 'Alephium', type: 'alephium' },
        'supra:supra': { name: 'Supra', type: 'supra' },
        'berachain:berachain': { name: 'Berachain', type: 'berachain' },
        'monad:monad': { name: 'Monad', type: 'monad' },
        'sonic:sonic': { name: 'Sonic', type: 'sonic' },
        'ink:ink': { name: 'Ink', type: 'ink' },
        'zora:zora': { name: 'Zora', type: 'zora' },
        'mantle:mantle': { name: 'Mantle', type: 'mantle' },
        'abstract:abstract': { name: 'Abstract', type: 'abstract' }
    };
    
    return chains[chainId] || { name: 'Unknown', type: 'unknown' };
}

module.exports = { detectChainId, getChainInfo };
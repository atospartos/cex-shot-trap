function getConfig(interval, INTERVAL_CONFIG) {
    const cfg = INTERVAL_CONFIG[interval];
    if (!cfg) throw new Error(`Unsupported interval: ${interval}`);
    return cfg;
}

function calculateActualDays(requestedDays, maxDays) {
    return Math.min(requestedDays, maxDays);
}

function calculateQueriesNeeded(actualDays, candlesPerDay) {
    const candlesNeeded = Math.ceil(actualDays * candlesPerDay);
    return Math.ceil(candlesNeeded / 500);
}

function median(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getConfig, calculateActualDays, calculateQueriesNeeded, median, sleep };
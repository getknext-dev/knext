
// Enough module body that V8 has real bytecode to cache.
exports.work = () => Array.from({ length: 64 }, (_, i) => i * i).reduce((a, b) => a + b, 0);


const helper = require("./helper.js");
const { getCompileCacheDir } = require("node:module");
const dir = typeof getCompileCacheDir === "function" ? getCompileCacheDir() : undefined;
process.stdout.write(JSON.stringify({ booted: true, work: helper.work(), compileCacheDir: dir ?? null }));

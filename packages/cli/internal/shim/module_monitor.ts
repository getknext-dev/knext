import type { CacheManager } from './cache_manager';

export class ModuleMonitor {
  private cacheManager: CacheManager;
  private totalModules = 0;
  private loadedModules = 0;
  private cacheThresholds: number[] = [20, 40, 60, 80, 100]; // Percentages to snapshot
  private lastCached = 0;
  private loadedUrls: Set<string> = new Set();

  // Metrics
  public metrics = {
    startTime: Date.now(),
    totalBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    snapshotsCreated: 0,
    loadTimes: [] as number[],
  };

  constructor(cacheManager: CacheManager) {
    this.cacheManager = cacheManager;
    console.info('[Monitor] 📊 Observability enabled - tracking all metrics');
  }

  async loadWithProgress(modules: string[]) {
    this.totalModules += modules.length;
    console.info(`[Monitor] Loading ${modules.length} modules (total: ${this.totalModules})`);

    for (const url of modules) {
      if (this.loadedUrls.has(url)) {
        console.info(`[Monitor] Skipping already loaded: ${url}`);
        continue;
      }

      const start = Date.now();
      await this.loadModule(url);
      const duration = Date.now() - start;
      this.metrics.loadTimes.push(duration);

      this.loadedModules++;
      this.loadedUrls.add(url);

      // Calculate progress
      const progress = Math.floor((this.loadedModules / this.totalModules) * 100);

      // Check if we hit a threshold for snapshotting
      if (progress >= this.cacheThresholds[0]) {
        const threshold = this.cacheThresholds.shift();
        if (threshold && threshold > this.lastCached) {
          console.info(`[Monitor] 🎯 ${threshold}% modules loaded - creating snapshot`);
          await this.createSnapshot(threshold);
          this.lastCached = threshold;
        }
      }
    }
  }

  async loadModule(url: string): Promise<any> {
    try {
      console.info(`[Monitor] Fetching ${url}...`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      // Write to disk relative to CWD (/app) so node_modules are resolvable
      const fileName = url.split('/').pop() || 'bundle.js';
      const filePath = `${process.cwd()}/${fileName}`;

      await Bun.write(filePath, await response.blob());

      console.info(`[Monitor] Saved to ${filePath}, importing...`);

      // Dynamic import handles ESM/CJS transparently and resolves imports from node_modules
      const mod = await import(filePath);

      // Register exports (optional, for tracking)
      if (mod) {
        (globalThis as any).__loaded_modules = (globalThis as any).__loaded_modules || {};
        (globalThis as any).__loaded_modules[url] = mod;

        // If it has a default export, store that too
        if (mod.default) {
          (globalThis as any).__loaded_modules[`${url}#default`] = mod.default;
        }
      }

      return mod;
    } catch (error) {
      this.metrics.cacheMisses++;
      console.error(`[Monitor] Failed to load ${url}:`, error);
      throw error;
    }
  }

  async createSnapshot(percentage: number) {
    try {
      this.metrics.snapshotsCreated++;
      await this.cacheManager.createSnapshot(percentage, Array.from(this.loadedUrls));
    } catch (e) {
      console.warn('[Monitor] Failed to create snapshot:', e);
    }
  }

  markLoaded(percentage: number) {
    this.loadedModules = Math.floor((percentage / 100) * this.totalModules);
    // Clean up thresholds
    this.cacheThresholds = this.cacheThresholds.filter((t) => t > percentage);
    this.lastCached = percentage;
  }

  getStats() {
    return {
      ...this.metrics,
      loaded: this.loadedModules,
      total: this.totalModules,
      percentage: Math.floor((this.loadedModules / (this.totalModules || 1)) * 100),
      cached: this.lastCached,
    };
  }
}

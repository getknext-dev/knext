// Module Loader - Lazy loads page bundles from GCS
// This runs in the server binary at runtime

interface ModuleCacheEntry {
  module: any;
  loadedAt: number;
}

class ModuleLoader {
  private cache = new Map<string, ModuleCacheEntry>();
  private loading = new Map<string, Promise<any>>();

  constructor(private bucketUrl = 'https://storage.googleapis.com/knative-next-assets-banna') {}

  /**
   * Load a page bundle from GCS on-demand
   * Caches the result in memory for subsequent requests
   */
  async loadPageBundle(route: string): Promise<any> {
    // Normalize route
    const normalizedRoute = route.replace(/^\//, '').replace(/\/$/, '') || 'home';

    // Check cache first
    const cached = this.cache.get(normalizedRoute);
    if (cached) {
      console.info(`[ModuleLoader] Cache hit for ${normalizedRoute}`);
      return cached.module;
    }

    // Check if already loading
    const loading = this.loading.get(normalizedRoute);
    if (loading) {
      console.info(`[ModuleLoader] Waiting for in-flight load of ${normalizedRoute}`);
      return loading;
    }

    // Load from GCS
    console.info(`[ModuleLoader] Loading bundle for ${normalizedRoute} from GCS...`);
    const loadPromise = this.fetchBundle(normalizedRoute);
    this.loading.set(normalizedRoute, loadPromise);

    try {
      const module = await loadPromise;
      this.cache.set(normalizedRoute, {
        module,
        loadedAt: Date.now(),
      });
      console.info(`[ModuleLoader] Successfully loaded ${normalizedRoute}`);
      return module;
    } finally {
      this.loading.delete(normalizedRoute);
    }
  }

  private async fetchBundle(route: string): Promise<any> {
    const bundleUrl = `${this.bucketUrl}/bundles/${route}.bundle.js`;

    try {
      // Fetch bundle from GCS
      const response = await fetch(bundleUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch bundle: ${response.status} ${response.statusText}`);
      }

      // Get bundle code as plain JavaScript
      const code = await response.text();

      // Create a module context
      const moduleExports: any = {};
      const module = { exports: moduleExports };

      // Create a require function that proxies to the runtime
      const requireFunc = (id: string) => {
        // For Next.js and React, use the embedded runtime
        if (id.startsWith('next') || id === 'react' || id === 'react-dom') {
          return (globalThis as any).__embedded_require(id);
        }
        // For relative paths, handle as needed
        throw new Error(`Module not found: ${id}`);
      };

      // Execute bundle in controlled context
      // The bundle is in CommonJS format: (function(exports, require, module) { ... })
      const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
      wrapper(moduleExports, requireFunc, module, `/${route}.bundle.js`, '/');

      // Return the exported module
      return module.exports;
    } catch (error) {
      console.error(`[ModuleLoader] Failed to load ${route}:`, error);
      throw error;
    }
  }

  /**
   * Preload bundles for faster subsequent requests
   */
  async preload(routes: string[]): Promise<void> {
    console.info(`[ModuleLoader] Preloading ${routes.length} bundles...`);
    await Promise.all(routes.map((route) => this.loadPageBundle(route)));
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      routes: Array.from(this.cache.keys()),
      memoryUsage: process.memoryUsage(),
    };
  }

  /**
   * Clear cache (useful for development/testing)
   */
  clearCache() {
    this.cache.clear();
    console.info('[ModuleLoader] Cache cleared');
  }
}

// Export singleton instance
export const moduleLoader = new ModuleLoader();

// Export for testing
export { ModuleLoader };

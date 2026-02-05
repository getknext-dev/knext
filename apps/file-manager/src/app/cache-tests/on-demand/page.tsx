import { revalidatePath, revalidateTag } from 'next/cache';
import { unstable_cache } from 'next/cache';

// Allow dynamic for server actions to work
export const dynamic = 'force-dynamic';

// Data cached with 'products' tag
const getProducts = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      items: ['Product A', 'Product B', 'Product C'],
      generatedAt: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['products-list'],
  { tags: ['products'] },
);

// Data cached with 'orders' tag
const getOrders = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      count: Math.floor(Math.random() * 100),
      generatedAt: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['orders-count'],
  { tags: ['orders'] },
);

// Data cached with both tags
const getSummary = unstable_cache(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      totalRevenue: `$${(Math.random() * 10000).toFixed(2)}`,
      generatedAt: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    };
  },
  ['summary-data'],
  { tags: ['products', 'orders'] },
);

async function invalidateProducts() {
  'use server';
  revalidateTag('products', 'max');
}

async function invalidateOrders() {
  'use server';
  revalidateTag('orders', 'max');
}

async function invalidatePath() {
  'use server';
  revalidatePath('/cache-tests/on-demand');
}

async function invalidateAll() {
  'use server';
  revalidateTag('products', 'max');
  revalidateTag('orders', 'max');
}

export default async function OnDemandPage() {
  const products = await getProducts();
  const orders = await getOrders();
  const summary = await getSummary();
  const renderTime = new Date().toISOString();

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🎯 On-Demand Revalidation</h1>
        <p className="text-gray-400">Testing revalidateTag() and revalidatePath() behaviors</p>
      </div>

      {/* Invalidation Controls */}
      <div className="mb-8 p-6 bg-white/5 border border-white/10 rounded-xl">
        <h2 className="text-lg font-semibold text-white mb-4">Invalidation Controls</h2>
        <div className="flex flex-wrap gap-3">
          <form action={invalidateProducts}>
            <button
              type="submit"
              className="px-4 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg transition-colors"
            >
              🏷️ Invalidate "products"
            </button>
          </form>
          <form action={invalidateOrders}>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded-lg transition-colors"
            >
              🏷️ Invalidate "orders"
            </button>
          </form>
          <form action={invalidatePath}>
            <button
              type="submit"
              className="px-4 py-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 rounded-lg transition-colors"
            >
              📁 Invalidate Path
            </button>
          </form>
          <form action={invalidateAll}>
            <button
              type="submit"
              className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-colors"
            >
              🔄 Invalidate All Tags
            </button>
          </form>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Products - tag: products */}
        <div className="bg-white/5 border border-green-500/30 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">📦</span>
            <h3 className="text-lg font-semibold text-white">Products</h3>
          </div>
          <span className="inline-block px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded-full mb-4">
            tag: products
          </span>
          <div className="space-y-2 text-sm">
            <p className="text-gray-400">
              Items: <span className="text-white">{products.items.join(', ')}</span>
            </p>
            <p className="text-gray-400">
              Generated:{' '}
              <span className="text-green-300 font-mono text-xs">{products.generatedAt}</span>
            </p>
            <p className="text-gray-500 font-mono text-xs">ID: {products.random}</p>
          </div>
        </div>

        {/* Orders - tag: orders */}
        <div className="bg-white/5 border border-blue-500/30 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">📋</span>
            <h3 className="text-lg font-semibold text-white">Orders</h3>
          </div>
          <span className="inline-block px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded-full mb-4">
            tag: orders
          </span>
          <div className="space-y-2 text-sm">
            <p className="text-gray-400">
              Count: <span className="text-white text-2xl font-bold">{orders.count}</span>
            </p>
            <p className="text-gray-400">
              Generated:{' '}
              <span className="text-blue-300 font-mono text-xs">{orders.generatedAt}</span>
            </p>
            <p className="text-gray-500 font-mono text-xs">ID: {orders.random}</p>
          </div>
        </div>

        {/* Summary - tags: products, orders */}
        <div className="bg-white/5 border border-purple-500/30 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">📊</span>
            <h3 className="text-lg font-semibold text-white">Summary</h3>
          </div>
          <div className="flex gap-2 mb-4">
            <span className="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded-full">
              products
            </span>
            <span className="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded-full">
              orders
            </span>
          </div>
          <div className="space-y-2 text-sm">
            <p className="text-gray-400">
              Revenue: <span className="text-white text-xl font-bold">{summary.totalRevenue}</span>
            </p>
            <p className="text-gray-400">
              Generated:{' '}
              <span className="text-purple-300 font-mono text-xs">{summary.generatedAt}</span>
            </p>
            <p className="text-gray-500 font-mono text-xs">ID: {summary.random}</p>
          </div>
        </div>
      </div>

      {/* Render timestamp */}
      <div className="mt-6 bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <p className="text-gray-500 text-sm">
          Page rendered at: <span className="text-gray-300 font-mono">{renderTime}</span>
        </p>
      </div>

      <div className="mt-8 p-6 bg-blue-500/10 border border-blue-500/30 rounded-xl">
        <h3 className="text-lg font-semibold text-blue-300 mb-2">🔍 What to Test</h3>
        <ul className="text-gray-300 text-sm space-y-2 list-disc list-inside">
          <li>Click "Invalidate products" - only Products and Summary should update</li>
          <li>Click "Invalidate orders" - only Orders and Summary should update</li>
          <li>Click "Invalidate Path" - everything on this page should update</li>
          <li>Check the Cache Monitor to see the invalidation events</li>
          <li>Summary has both tags, so it updates when either is invalidated</li>
        </ul>
      </div>
    </div>
  );
}

import { setCacheHandler } from 'next/cache';
import CacheHandler from '../cache-handler.js';

let initialized = false;
if (!initialized) {
    initialized = true;
    setCacheHandler(new CacheHandler());
    console.log('[Cache Init] Registered Custom CacheHandler');
}

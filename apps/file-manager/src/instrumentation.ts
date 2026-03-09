import { registerOTel } from '@vercel/otel';
import { setCacheHandler } from 'next/cache';
import CacheHandler from '../cache-handler.js';

export function register() {
  setCacheHandler(new CacheHandler());
  registerOTel({
    serviceName: 'file-manager',
  });
}

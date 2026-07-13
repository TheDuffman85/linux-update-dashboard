import { createMiddleware } from "hono/factory";
import { getClientIp } from "../request-security";

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();
const MAX_RATE_LIMIT_BUCKETS = 10_000;
let lastPruneAt = 0;

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 120_000);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 300_000);

/**
 * Create a rate limiting middleware.
 * @param maxRequests Maximum requests allowed in the window
 * @param windowMs Time window in milliseconds
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return createMiddleware(async (c, next) => {
    const ip = getClientIp(c) || "unknown";
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    if (now - lastPruneAt >= 30_000) {
      for (const [storedKey, storedEntry] of store) {
        storedEntry.timestamps = storedEntry.timestamps.filter(
          (t) => now - t < windowMs,
        );
        if (storedEntry.timestamps.length === 0) store.delete(storedKey);
      }
      lastPruneAt = now;
    }

    let entry = store.get(key);
    if (!entry) {
      if (store.size >= MAX_RATE_LIMIT_BUCKETS) {
        return c.json({ error: "Rate limiter is busy" }, 429);
      }
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      const oldestInWindow = entry.timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests" }, 429);
    }

    entry.timestamps.push(now);
    return next();
  });
}

// Tiny in-memory TTL cache with in-flight de-duplication.
//
// Why: the Search tab fires two requests per query (results + AI overview),
// Herald AI's search tool hits the same engines, and people re-run the same
// searches constantly. `remember()` makes concurrent callers share ONE
// upstream call and lets repeats be answered instantly from memory.
// Lives in the Node process only (no Redis needed) — it simply empties when
// Render restarts the service, which is fine for a cache.

const store = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise
const MAX_ENTRIES = 500;

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlMs) {
  if (store.size >= MAX_ENTRIES) {
    // Drop the oldest entry (Maps iterate in insertion order).
    store.delete(store.keys().next().value);
  }
  store.set(key, { value, expires: Date.now() + ttlMs });
}

// remember(key, ttlMs, fn, shouldCache?) — returns the cached value, joins an
// in-flight call for the same key, or runs fn() and caches the result.
// `shouldCache(value)` lets callers refuse to cache bad results (e.g. an
// empty search caused by a cold-starting engine) so they get retried.
async function remember(key, ttlMs, fn, shouldCache = () => true) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await fn();
      if (shouldCache(value)) set(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

module.exports = { get, set, remember };

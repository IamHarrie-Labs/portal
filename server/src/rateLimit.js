// Minimal in-memory, per-IP sliding-window rate limiter. No new dependency:
// this app has one process and modest traffic, so a Map is plenty.
export function rateLimit({ windowMs, max, message = 'Too many requests. Please slow down.' }) {
  const hits = new Map(); // ip -> timestamps[]

  // Periodically forget IPs with no recent activity so this Map can't grow forever.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, Math.max(windowMs, 60_000)).unref();

  return (req, res, next) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (times.length >= max) {
      return res.status(429).json({ error: message });
    }
    times.push(now);
    hits.set(ip, times);
    next();
  };
}

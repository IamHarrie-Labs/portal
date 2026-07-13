import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Falls back to a secret persisted on disk (not a random one per boot) so
// sessions survive a server restart even without PORTAL_JWT_SECRET set.
function loadOrCreateJwtSecret() {
  if (process.env.PORTAL_JWT_SECRET) return process.env.PORTAL_JWT_SECRET;
  const secretPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.jwt-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, 'utf8');
    return secret;
  }
}

export const JWT_SECRET = loadOrCreateJwtSecret();

// Creator account tokens are a distinct role from end-user login/gate session
// tokens (index.js's /auth/status token), so a stolen end-user token can never
// be replayed against creator-only routes and vice versa.
export function signCreatorToken(creator) {
  return jwt.sign({ sub: creator.id, role: 'creator' }, JWT_SECRET, { expiresIn: '7d' });
}

export function requireCreator(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'creator') return res.status(403).json({ error: 'not a creator token' });
    req.creatorId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

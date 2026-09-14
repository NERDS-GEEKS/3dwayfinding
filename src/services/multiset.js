/**
 * MultiSet VPS — machine token and per-project map code.
 *
 * The map code is read from `navme_logins` rather than hardcoded, so each
 * project localizes against its own map. Codes beginning `MSET_` are map SETS
 * and must be sent as `mapSetCode`; plain `MAP_` codes go in `mapCode`.
 */
import { query } from './supabase.js';

const MULTISET_API = 'https://api.multiset.ai';

/** Same-origin proxy in dev so the browser is not blocked by CORS. */
export function multisetApiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const override = import.meta.env.VITE_MULTISET_API_URL;
  if (typeof override === 'string' && override.trim()) {
    return `${override.trim().replace(/\/$/, '')}${p}`;
  }
  if (import.meta.env.DEV) return `/api/multiset${p}`;
  return `${MULTISET_API}${p}`;
}

let cachedToken = null;
let tokenExpiry = 0;
let cachedCredsKey = '';

/**
 * MultiSet settings for a project: the map code plus the credentials that
 * unlock it. All three sit next to each other on `navme_logins`, so one read
 * gets everything — and nothing has to be baked into the bundle at build time,
 * which also means a client secret is not shipped to every visitor.
 *
 * @param {string} poiType
 * @returns {Promise<{mapCode:string, clientId:string, clientSecret:string}>}
 */
export async function fetchMultisetConfig(poiType) {
  const rows = await query(
    `navme_logins?select=map_code,client_id,client_secret&poi_type=eq.${encodeURIComponent(poiType)}&limit=1`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const mapCode = String(row?.map_code ?? '').trim();
  const clientId = String(row?.client_id ?? '').trim();
  const clientSecret = String(row?.client_secret ?? '').trim();
  if (!mapCode) throw new Error(`No MultiSet map code for project \u201c${poiType}\u201d`);
  if (!clientId || !clientSecret) {
    throw new Error(`No MultiSet credentials stored for project \u201c${poiType}\u201d`);
  }
  return { mapCode, clientId, clientSecret };
}

/**
 * Machine-to-machine token. Cached until shortly before it expires — a token
 * request per localization attempt would triple the round trips. Keyed by the
 * credentials so switching project cannot reuse the wrong token.
 */
export async function getMultisetToken({ clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error('MultiSet credentials missing — localization cannot start.');
  }
  const key = `${clientId}:${clientSecret}`;
  if (cachedToken && key === cachedCredsKey && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(multisetApiUrl('/v1/m2m/token'), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(key)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MultiSet auth failed (${res.status}): ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const token = data.token || data.access_token;
  if (!token) throw new Error('No token in MultiSet auth response');
  cachedToken = token;
  cachedCredsKey = key;
  // Refresh a minute early rather than discovering expiry mid-scan.
  tokenExpiry =
    Date.now() + (Number(data.expiresIn) > 0 ? Number(data.expiresIn) * 1000 : 3600_000) - 60_000;
  return token;
}

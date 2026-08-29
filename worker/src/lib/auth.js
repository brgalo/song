// Zwei Wege hinein, ein Ergebnis: eine verifizierte Identitaet.
//
//   Browser (songou-auth, hinter Access) -> Cf-Access-Jwt-Assertion
//   Desktop-App (nativ)                  -> Authorization: Bearer <device-token>
//
// Die Desktop-App kann aus einem fetch() heraus keinen Access-Login-Redirect
// verarbeiten, deshalb der zweite Weg. Was der Client als Autor behauptet,
// wird nirgends geglaubt - comments.author kommt immer von hier.

import { unauthorized } from './http.js';

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksCache = new Map(); // teamDomain -> { keys, fetchedAt }

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlToString = (s) => new TextDecoder().decode(b64urlToBytes(s));

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getJwks(teamDomain) {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw unauthorized('Access-Zertifikate nicht erreichbar');
  const body = await res.json();
  const keys = body.keys || [];
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Verifiziert das von Cloudflare Access gesetzte JWT und gibt die Mailadresse
 * zurueck. Wirft, wenn irgendetwas daran nicht stimmt.
 */
export async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Access-Token hat falsches Format');
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlToString(rawHeader));
    payload = JSON.parse(b64urlToString(rawPayload));
  } catch {
    throw unauthorized('Access-Token nicht lesbar');
  }
  if (header.alg !== 'RS256') throw unauthorized('Unerwarteter Signaturalgorithmus');

  const keys = await getJwks(env.ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw unauthorized('Signaturschluessel unbekannt');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) throw unauthorized('Signatur ungueltig');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) throw unauthorized('Access-Token abgelaufen');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw unauthorized('Access-Token noch nicht gueltig');

  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw unauthorized('Falscher Aussteller');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw unauthorized('Token gilt fuer eine andere Anwendung');

  const identity = payload.email || payload.common_name;
  if (!identity) throw unauthorized('Token enthaelt keine Identitaet');
  return identity;
}

const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

async function identityFromDeviceToken(token, env, ctx) {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT identity, last_seen FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL',
  ).bind(hash).first();
  if (!row) throw unauthorized('Geraetetoken unbekannt oder zurueckgezogen');

  // last_seen nur stuendlich fortschreiben. Sonst kostet jeder Poll des
  // Sync-Agents einen D1-Write, und davon gibt es im Free-Plan 100k pro Tag.
  const stale = !row.last_seen || Date.now() - Date.parse(row.last_seen) > LAST_SEEN_THROTTLE_MS;
  if (stale) {
    const update = env.DB.prepare('UPDATE devices SET last_seen = ?1 WHERE token_hash = ?2')
      .bind(new Date().toISOString(), hash)
      .run();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(update);
    else await update;
  }
  return row.identity;
}

/**
 * Ermittelt die Identitaet des Aufrufers. Reihenfolge: Device-Token zuerst,
 * weil das der haeufigere Fall ist (Desktop-App), Access-JWT als Zweites.
 */
export async function authenticate(request, env, ctx) {
  const bearer = request.headers.get('authorization');
  if (bearer && bearer.startsWith('Bearer ')) {
    return identityFromDeviceToken(bearer.slice(7).trim(), env, ctx);
  }
  const accessJwt =
    request.headers.get('cf-access-jwt-assertion') ||
    cookieValue(request.headers.get('cookie'), 'CF_Authorization');
  if (accessJwt) return verifyAccessJwt(accessJwt, env);

  throw unauthorized('Kein Zugangstoken mitgeschickt');
}

export function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Erzeugt ein neues Geraetetoken und legt nur dessen Hash ab. */
export async function createDeviceToken(env, identity, label) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.DB.prepare(
    'INSERT INTO devices (token_hash, identity, label, created_at) VALUES (?1, ?2, ?3, ?4)',
  ).bind(await sha256Hex(token), identity, label || null, new Date().toISOString()).run();
  return token;
}

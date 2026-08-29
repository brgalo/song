// Lesepfad: was es an Songs, Versionen und Konfiguration gibt, und wie die
// Clients an Audio und Peaks kommen.

import { json, notFound, badRequest } from '../lib/http.js';
import { storageLimitBytes } from '../lib/storage.js';

async function readSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of results) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

/**
 * Ein Aufruf beim App-Start: Band-Konfiguration plus die komplette Bibliothek.
 * Ersetzt read_config und scan_directory der alten Fassung.
 */
export async function bootstrap({ env, identity }) {
  const [settings, songs, versions] = await Promise.all([
    readSettings(env),
    env.DB.prepare(
      'SELECT id, name, created_at FROM songs WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE',
    ).all(),
    env.DB.prepare(
      `SELECT id, song_id, filename, sha256, bytes, duration, created_at, uploaded_by
         FROM versions
        WHERE deleted_at IS NULL AND ready = 1
        ORDER BY created_at`,
    ).all(),
  ]);

  const bySong = new Map();
  for (const v of versions.results) {
    if (!bySong.has(v.song_id)) bySong.set(v.song_id, []);
    bySong.get(v.song_id).push(v);
  }

  return json({
    identity,
    bandName: settings.band_name || 'Band',
    members: settings.members || {},
    tags: settings.tags || [],
    songs: songs.results.map((s) => ({ ...s, versions: bySong.get(s.id) || [] })),
  });
}

async function versionRow(env, versionId) {
  const row = await env.DB.prepare(
    'SELECT id, r2_key, peaks_key, filename FROM versions WHERE id = ?1 AND deleted_at IS NULL',
  ).bind(versionId).first();
  if (!row) throw notFound('Unbekannte Version');
  return row;
}

/**
 * Liefert das Audio. Range-Requests werden durchgereicht, damit im Player
 * gescrubbt werden kann, ohne die ganze Datei zu laden.
 */
export async function audio({ request, env, params }) {
  const version = await versionRow(env, params.versionId);
  const range = request.headers.get('range');

  const object = await env.BUCKET.get(version.r2_key, range ? { range: request.headers } : undefined);
  if (!object) throw notFound('Audio liegt nicht in R2');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  if (!headers.has('content-type')) headers.set('content-type', 'audio/mpeg');

  if (object.range && object.size !== undefined) {
    const start = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - start;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

/** Vorberechnete Waveform-Peaks - dadurch zeichnet der Client sofort. */
export async function peaks({ env, params }) {
  const version = await versionRow(env, params.versionId);
  if (!version.peaks_key) throw notFound('Fuer diese Version gibt es keine Peaks');

  const object = await env.BUCKET.get(version.peaks_key);
  if (!object) throw notFound('Peaks liegen nicht in R2');

  return new Response(object.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}

/**
 * Belegter Speicher gegen das Limit. Der Sync-Agent zeigt das im Tray an;
 * durchgesetzt wird das Limit aber serverseitig in upload/prepare, damit es
 * auch dann greift, wenn ein Agent aelter oder kaputt ist.
 */
export async function usage({ env }) {
  const [row, limit] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM versions WHERE deleted_at IS NULL').first(),
    storageLimitBytes(env),
  ]);
  const bytes = Number(row?.total ?? 0);
  return json({ bytes, limitBytes: limit, remainingBytes: Math.max(0, limit - bytes) });
}

/**
 * Neue Versionen seit einem Zeitpunkt. Speist die Benachrichtigung des
 * Sync-Agents und das "neu"-Abzeichen in der Oberflaeche.
 */
export async function feed({ env, url }) {
  const since = url.searchParams.get('since');
  if (since && Number.isNaN(Date.parse(since))) throw badRequest('since muss ISO-8601 sein');

  const { results } = await env.DB.prepare(
    `SELECT v.id, v.filename, v.created_at, v.uploaded_by, s.name AS song_name
       FROM versions v JOIN songs s ON s.id = v.song_id
      WHERE v.deleted_at IS NULL AND v.ready = 1 AND v.created_at > ?1
      ORDER BY v.created_at
      LIMIT 100`,
  ).bind(since || '1970-01-01T00:00:00.000Z').all();

  return json({ versions: results, now: new Date().toISOString() });
}

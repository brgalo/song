// Ingest-Pfad des Sync-Agents.
//
//   prepare  -> kennt der Server den Hash schon? Dann ist nichts zu tun.
//   blob     -> die Bytes selbst.
//   complete -> Dauer und vorberechnete Peaks, danach ist die Version sichtbar.
//
// Der Dreischritt existiert wegen des Dedups: Laufen bei fuenf Bandmitgliedern
// fuenf Agents, sollen nicht fuenf denselben Song hochladen. Wer zuerst
// prepare aufruft, laedt hoch; alle anderen bekommen known:true und hoeren auf.

import { json, readJson, badRequest, notFound, tooLarge, nowIso } from '../lib/http.js';
import { ulid } from '../lib/ulid.js';

// Workers nehmen im Free-Plan maximal 100 MB Request-Body an. VBR0-MP3s liegen
// bei ~7 MB, das ist also reichlich Luft. Wir bremsen frueher, damit ein
// versehentlich abgelegtes langes WAV eine verstaendliche Fehlermeldung
// bekommt statt eines nackten 413 von der Plattform.
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Legt den Song an, falls es ihn noch nicht gibt, und gibt seine ID zurueck. */
async function ensureSong(env, name, ts) {
  const existing = await env.DB.prepare(
    'SELECT id FROM songs WHERE name = ?1 AND deleted_at IS NULL',
  ).bind(name).first();
  if (existing) return existing.id;

  const id = ulid();
  await env.DB.prepare(
    'INSERT INTO songs (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
  ).bind(id, name, ts).run();
  return id;
}

export async function prepare({ request, env, identity }) {
  const body = await readJson(request);
  const { sha256, filename, songName, bytes } = body;

  if (!SHA256_RE.test(String(sha256 || ''))) throw badRequest('sha256 fehlt oder ist kein Hex-Digest');
  if (!filename || typeof filename !== 'string') throw badRequest('filename fehlt');
  if (!songName || typeof songName !== 'string') throw badRequest('songName fehlt');
  if (!Number.isInteger(bytes) || bytes <= 0) throw badRequest('bytes muss eine positive Ganzzahl sein');
  if (bytes > MAX_UPLOAD_BYTES) throw tooLarge(`Datei ist groesser als ${MAX_UPLOAD_BYTES} Bytes`);

  // Hat ein anderer Agent die Datei schon vollstaendig hochgeladen?
  const known = await env.DB.prepare(
    'SELECT id, ready FROM versions WHERE sha256 = ?1',
  ).bind(sha256).first();
  if (known && known.ready) return json({ known: true, versionId: known.id });

  const ts = nowIso();
  // Ein abgebrochener Upload hinterlaesst eine Zeile mit ready = 0. Die wird
  // wiederverwendet, statt eine zweite anzulegen - sha256 ist UNIQUE.
  if (known) return json({ known: false, versionId: known.id, uploadPath: `/api/upload/blob/${known.id}` });

  const songId = await ensureSong(env, songName, ts);
  const versionId = ulid();
  await env.DB.prepare(
    `INSERT INTO versions (id, song_id, filename, sha256, bytes, r2_key, ready, uploaded_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8)`,
  ).bind(versionId, songId, filename, sha256, bytes, `audio/${sha256}`, identity, ts).run();

  return json({ known: false, versionId, uploadPath: `/api/upload/blob/${versionId}` });
}

export async function uploadBlob({ request, env, params }) {
  const version = await env.DB.prepare(
    'SELECT id, sha256, bytes, r2_key, ready FROM versions WHERE id = ?1',
  ).bind(params.versionId).first();
  if (!version) throw notFound('Unbekannte Version');
  if (version.ready) return json({ ok: true, alreadyUploaded: true });

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > MAX_UPLOAD_BYTES) throw tooLarge('Datei zu gross');
  if (!request.body) throw badRequest('Kein Body');

  await env.BUCKET.put(version.r2_key, request.body, {
    httpMetadata: { contentType: request.headers.get('content-type') || 'audio/mpeg' },
  });

  // ready wird bewusst erst in complete gesetzt: erst mit Dauer und Peaks ist
  // die Version fuer die Clients brauchbar.
  return json({ ok: true });
}

export async function complete({ request, env, params }) {
  const body = await readJson(request);
  const { duration, peaks } = body;

  const version = await env.DB.prepare(
    'SELECT id, sha256, r2_key FROM versions WHERE id = ?1',
  ).bind(params.versionId).first();
  if (!version) throw notFound('Unbekannte Version');

  const head = await env.BUCKET.head(version.r2_key);
  if (!head) throw badRequest('Audio liegt nicht in R2 - erst /api/upload/blob aufrufen');

  let peaksKey = null;
  if (peaks !== undefined && peaks !== null) {
    if (!Array.isArray(peaks)) throw badRequest('peaks muss ein Array von Kanaelen sein');
    peaksKey = `peaks/${version.sha256}.json`;
    await env.BUCKET.put(peaksKey, JSON.stringify(peaks), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  if (duration !== undefined && duration !== null && !(Number(duration) > 0)) {
    throw badRequest('duration muss eine positive Zahl sein');
  }

  await env.DB.prepare(
    'UPDATE versions SET duration = ?1, peaks_key = ?2, ready = 1, updated_at = ?3 WHERE id = ?4',
  ).bind(duration ?? null, peaksKey, nowIso(), version.id).run();

  return json({ ok: true, versionId: version.id });
}

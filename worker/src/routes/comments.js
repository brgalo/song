// Kommentare - das Herzstueck des Ports.
//
// Gegenueber der alten comments.json aendert sich dreierlei:
//   * Antworten haengen flach an parent_id statt in verschachtelten Arrays.
//     Nebenbei behoben: Reaktionen und Bearbeiten fanden Antworten frueher
//     gar nicht, weil .find() nur die oberste Ebene absuchte.
//   * Die ID kommt vom Client, deshalb ist POST idempotent.
//   * Geloescht wird nie hart, nur per deleted_at.

import { json, readJson, badRequest, notFound, nowIso } from '../lib/http.js';
import { isValidId } from '../lib/ulid.js';

const ANCHOR_TYPES = new Set(['range', 'point', 'none']);
const MAX_TEXT_LENGTH = 5000;

function parseAnchor(body) {
  const type = body.anchorType;
  if (!ANCHOR_TYPES.has(type)) throw badRequest("anchorType muss 'range', 'point' oder 'none' sein");

  if (type === 'none') return { anchorType: type, startS: null, endS: null };

  const start = Number(body.startS);
  if (!Number.isFinite(start) || start < 0) throw badRequest('startS muss eine Zahl >= 0 sein');

  if (type === 'point') return { anchorType: type, startS: start, endS: null };

  const end = Number(body.endS);
  if (!Number.isFinite(end) || end <= start) throw badRequest('endS muss groesser als startS sein');
  return { anchorType: type, startS: start, endS: end };
}

function normalizeTags(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('tags muss ein Array sein');
  const cleaned = raw
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 40);
  return [...new Set(cleaned)];
}

/** Haengt Tags und Reaktionen an eine Liste von Kommentarzeilen. */
async function decorate(env, rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');

  const [tags, reactions] = await Promise.all([
    env.DB.prepare(`SELECT comment_id, tag FROM comment_tags WHERE comment_id IN (${placeholders})`).bind(...ids).all(),
    env.DB.prepare(`SELECT comment_id, author, emoji FROM reactions WHERE comment_id IN (${placeholders})`).bind(...ids).all(),
  ]);

  const tagsBy = new Map();
  for (const t of tags.results) {
    if (!tagsBy.has(t.comment_id)) tagsBy.set(t.comment_id, []);
    tagsBy.get(t.comment_id).push(t.tag);
  }
  const reactionsBy = new Map();
  for (const r of reactions.results) {
    if (!reactionsBy.has(r.comment_id)) reactionsBy.set(r.comment_id, {});
    const byEmoji = reactionsBy.get(r.comment_id);
    (byEmoji[r.emoji] ||= []).push(r.author);
  }

  return rows.map((r) => ({
    ...r,
    resolved: !!r.resolved,
    tags: tagsBy.get(r.id) || [],
    reactions: reactionsBy.get(r.id) || {},
  }));
}

/**
 * Geloescht heisst geloescht: Text, Tags und Reaktionen einer entfernten
 * Zeile verlassen den Server nicht. Uebrig bleibt die Huelle mit deleted_at,
 * an der die Oberflaeche den Platzhalter erkennt.
 */
function stripDeleted(comments) {
  return comments.map((c) => (c.deleted_at ? { ...c, text: '', tags: [], reactions: {} } : c));
}

export async function list({ env, url }) {
  const songId = url.searchParams.get('songId');
  const since = url.searchParams.get('since');
  if (since && Number.isNaN(Date.parse(since))) throw badRequest('since muss ISO-8601 sein');

  // Mit since kommen auch Tombstones mit, damit ein Client geloeschte
  // Kommentare entfernen kann statt sie ewig anzuzeigen.
  //
  // Ohne since bleiben geloeschte Kommentare grundsaetzlich draussen - mit
  // einer Ausnahme: haengt noch eine lebende Antwort daran, wird die Huelle
  // mitgeliefert. Sonst verschwaende ein geloeschter Root-Kommentar die
  // ganze Diskussion darunter, statt einen Platzhalter zu hinterlassen.
  const conditions = [];
  const binds = [];
  if (songId) { binds.push(songId); conditions.push(`song_id = ?${binds.length}`); }
  if (since) { binds.push(since); conditions.push(`updated_at > ?${binds.length}`); }
  else {
    conditions.push(`(deleted_at IS NULL OR EXISTS (
        SELECT 1 FROM comments AS reply
         WHERE reply.parent_id = comments.id AND reply.deleted_at IS NULL))`);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, song_id, version_id, parent_id, anchor_type, start_s, end_s,
            author, text, resolved, created_at, updated_at, deleted_at
       FROM comments
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY updated_at`,
  ).bind(...binds).all();

  return json({ comments: stripDeleted(await decorate(env, results)), now: nowIso() });
}

export async function create({ request, env, identity }) {
  const body = await readJson(request);

  if (!isValidId(body.id)) throw badRequest('id fehlt oder ist ungueltig (ULID erwartet)');
  if (!body.songId) throw badRequest('songId fehlt');
  const text = String(body.text ?? '').trim();
  if (!text) throw badRequest('text darf nicht leer sein');
  if (text.length > MAX_TEXT_LENGTH) throw badRequest('text ist zu lang');

  const { anchorType, startS, endS } = parseAnchor(body);
  const tags = normalizeTags(body.tags);
  const ts = nowIso();

  const song = await env.DB.prepare('SELECT id FROM songs WHERE id = ?1 AND deleted_at IS NULL')
    .bind(body.songId).first();
  if (!song) throw notFound('Unbekannter Song');

  // INSERT OR IGNORE macht den Retry nach Netzabbruch folgenlos.
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO comments
       (id, song_id, version_id, parent_id, anchor_type, start_s, end_s,
        author, text, resolved, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)`,
  ).bind(
    body.id, body.songId, body.versionId || null, body.parentId || null,
    anchorType, startS, endS, identity, text, ts,
  ).run();

  const inserted = insert.meta.changes > 0;
  if (inserted && tags.length) {
    await env.DB.batch(
      tags.map((tag) =>
        env.DB.prepare('INSERT OR IGNORE INTO comment_tags (comment_id, tag) VALUES (?1, ?2)').bind(body.id, tag),
      ),
    );
  }

  const row = await env.DB.prepare('SELECT * FROM comments WHERE id = ?1').bind(body.id).first();
  const [decorated] = await decorate(env, [row]);
  return json({ comment: decorated, created: inserted }, { status: inserted ? 201 : 200 });
}

export async function update({ request, env, params, identity }) {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT * FROM comments WHERE id = ?1').bind(params.id).first();
  if (!existing || existing.deleted_at) throw notFound('Unbekannter Kommentar');
  if (existing.author !== identity) throw badRequest('Nur der Autor kann den Kommentar aendern');

  const sets = [];
  const binds = [];
  if (body.text !== undefined) {
    const text = String(body.text).trim();
    if (!text) throw badRequest('text darf nicht leer sein');
    if (text.length > MAX_TEXT_LENGTH) throw badRequest('text ist zu lang');
    binds.push(text); sets.push(`text = ?${binds.length}`);
  }
  if (body.resolved !== undefined) {
    binds.push(body.resolved ? 1 : 0); sets.push(`resolved = ?${binds.length}`);
  }
  if (body.anchorType !== undefined) {
    const a = parseAnchor(body);
    binds.push(a.anchorType); sets.push(`anchor_type = ?${binds.length}`);
    binds.push(a.startS); sets.push(`start_s = ?${binds.length}`);
    binds.push(a.endS); sets.push(`end_s = ?${binds.length}`);
  }
  if (!sets.length && body.tags === undefined) throw badRequest('Nichts zu aendern');

  const ts = nowIso();
  if (sets.length) {
    binds.push(ts); sets.push(`updated_at = ?${binds.length}`);
    binds.push(params.id);
    await env.DB.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run();
  }

  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    const statements = [env.DB.prepare('DELETE FROM comment_tags WHERE comment_id = ?1').bind(params.id)];
    for (const tag of tags) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO comment_tags (comment_id, tag) VALUES (?1, ?2)').bind(params.id, tag));
    }
    statements.push(env.DB.prepare('UPDATE comments SET updated_at = ?1 WHERE id = ?2').bind(ts, params.id));
    await env.DB.batch(statements);
  }

  const row = await env.DB.prepare('SELECT * FROM comments WHERE id = ?1').bind(params.id).first();
  const [decorated] = await decorate(env, [row]);
  return json({ comment: decorated });
}

export async function remove({ env, params, identity }) {
  const existing = await env.DB.prepare('SELECT author, deleted_at FROM comments WHERE id = ?1')
    .bind(params.id).first();
  if (!existing) throw notFound('Unbekannter Kommentar');
  if (existing.author !== identity) throw badRequest('Nur der Autor kann den Kommentar loeschen');
  if (existing.deleted_at) return json({ ok: true, alreadyDeleted: true });

  const ts = nowIso();
  // Tombstone statt DELETE: sonst holt ein spaeterer Offline-Sync den
  // Kommentar wieder zurueck.
  await env.DB.prepare('UPDATE comments SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2')
    .bind(ts, params.id).run();
  return json({ ok: true });
}

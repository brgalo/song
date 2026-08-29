// Reaktionen sind eine eigene Tabelle statt eines {emoji: [namen]}-Blobs.
// Dadurch ist das Umschalten ein INSERT bzw. DELETE, statt die gesamte
// Kommentarliste zu lesen, zu aendern und zurueckzuschreiben.

import { json, badRequest, notFound, nowIso } from '../lib/http.js';

// Bewusst dieselbe Auswahl wie bisher in der Oberflaeche.
const ALLOWED = new Set(['\u{1F44D}', '❤️', '\u{1F525}', '\u{1F602}', '\u{1F62E}']);

async function requireComment(env, commentId) {
  const row = await env.DB.prepare('SELECT id FROM comments WHERE id = ?1 AND deleted_at IS NULL')
    .bind(commentId).first();
  if (!row) throw notFound('Unbekannter Kommentar');
}

export async function add({ env, params, identity }) {
  if (!ALLOWED.has(params.emoji)) throw badRequest('Unbekannte Reaktion');
  await requireComment(env, params.commentId);

  await env.DB.prepare(
    'INSERT OR IGNORE INTO reactions (comment_id, author, emoji, created_at) VALUES (?1, ?2, ?3, ?4)',
  ).bind(params.commentId, identity, params.emoji, nowIso()).run();

  return json({ ok: true });
}

export async function remove({ env, params, identity }) {
  await env.DB.prepare(
    'DELETE FROM reactions WHERE comment_id = ?1 AND author = ?2 AND emoji = ?3',
  ).bind(params.commentId, identity, params.emoji).run();

  return json({ ok: true });
}

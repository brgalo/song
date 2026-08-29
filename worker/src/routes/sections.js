// Song-Abschnitte (Intro, Chorus 2, Break downtune ...). Sie haengen an einer
// konkreten Version, weil sich mit einem neuen Bounce auch das Arrangement
// verschieben kann.

import { json, readJson, badRequest, notFound, nowIso } from '../lib/http.js';
import { isValidId } from '../lib/ulid.js';

const TYPES = new Set(['intro', 'verse', 'chorus', 'bridge', 'break', 'solo', 'outro']);

function parseBody(body) {
  if (!TYPES.has(body.type)) throw badRequest(`type muss eines von ${[...TYPES].join(', ')} sein`);

  const start = Number(body.startS);
  const end = Number(body.endS);
  if (!Number.isFinite(start) || start < 0) throw badRequest('startS muss eine Zahl >= 0 sein');
  if (!Number.isFinite(end) || end <= start) throw badRequest('endS muss groesser als startS sein');

  return {
    type: body.type,
    startS: start,
    endS: end,
    variant: body.variant ? String(body.variant).slice(0, 40) : null,
    label: body.label ? String(body.label).slice(0, 120) : null,
    color: body.color ? String(body.color).slice(0, 32) : null,
  };
}

export async function list({ env, url }) {
  const versionId = url.searchParams.get('versionId');
  const since = url.searchParams.get('since');
  if (!versionId && !since) throw badRequest('versionId oder since noetig');
  if (since && Number.isNaN(Date.parse(since))) throw badRequest('since muss ISO-8601 sein');

  const conditions = [];
  const binds = [];
  if (versionId) { binds.push(versionId); conditions.push(`version_id = ?${binds.length}`); }
  if (since) { binds.push(since); conditions.push(`updated_at > ?${binds.length}`); }
  else conditions.push('deleted_at IS NULL');

  const { results } = await env.DB.prepare(
    `SELECT * FROM sections WHERE ${conditions.join(' AND ')} ORDER BY start_s`,
  ).bind(...binds).all();

  return json({ sections: results, now: nowIso() });
}

export async function create({ request, env }) {
  const body = await readJson(request);
  if (!isValidId(body.id)) throw badRequest('id fehlt oder ist ungueltig');
  if (!body.versionId) throw badRequest('versionId fehlt');

  const version = await env.DB.prepare('SELECT id FROM versions WHERE id = ?1 AND deleted_at IS NULL')
    .bind(body.versionId).first();
  if (!version) throw notFound('Unbekannte Version');

  const parsed = parseBody(body);
  const ts = nowIso();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO sections
       (id, version_id, start_s, end_s, type, variant, label, color, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(
    body.id, body.versionId, parsed.startS, parsed.endS,
    parsed.type, parsed.variant, parsed.label, parsed.color, ts,
  ).run();

  const row = await env.DB.prepare('SELECT * FROM sections WHERE id = ?1').bind(body.id).first();
  return json({ section: row, created: result.meta.changes > 0 }, { status: result.meta.changes > 0 ? 201 : 200 });
}

export async function update({ request, env, params }) {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT * FROM sections WHERE id = ?1').bind(params.id).first();
  if (!existing || existing.deleted_at) throw notFound('Unbekannter Abschnitt');

  const parsed = parseBody({
    type: body.type ?? existing.type,
    startS: body.startS ?? existing.start_s,
    endS: body.endS ?? existing.end_s,
    variant: body.variant ?? existing.variant,
    label: body.label ?? existing.label,
    color: body.color ?? existing.color,
  });

  const ts = nowIso();
  await env.DB.prepare(
    `UPDATE sections SET start_s = ?1, end_s = ?2, type = ?3, variant = ?4,
            label = ?5, color = ?6, updated_at = ?7
      WHERE id = ?8`,
  ).bind(parsed.startS, parsed.endS, parsed.type, parsed.variant, parsed.label, parsed.color, ts, params.id).run();

  const row = await env.DB.prepare('SELECT * FROM sections WHERE id = ?1').bind(params.id).first();
  return json({ section: row });
}

export async function remove({ env, params }) {
  const existing = await env.DB.prepare('SELECT deleted_at FROM sections WHERE id = ?1').bind(params.id).first();
  if (!existing) throw notFound('Unbekannter Abschnitt');
  if (existing.deleted_at) return json({ ok: true, alreadyDeleted: true });

  const ts = nowIso();
  await env.DB.prepare('UPDATE sections SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2')
    .bind(ts, params.id).run();
  return json({ ok: true });
}

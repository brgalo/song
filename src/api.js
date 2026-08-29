// Zugriff auf songou-api aus der Oberflaeche.
//
// Einzige Stelle, die weiss, woher die Daten kommen. Phase 3 baut hier den
// Offline-Layer dahinter - das restliche Frontend merkt davon nichts.

const invoke = window.__TAURI__.core.invoke;

let baseUrl = '';

export function setBaseUrl(url) {
  baseUrl = (url || '').replace(/\/+$/, '');
}

/**
 * Das Geraetetoken bleibt im Rust-Teil. Die Oberflaeche schickt ihre Aufrufe
 * deshalb ueber Rust, statt das Token in JavaScript zu halten - dort waere es
 * ueber die Entwicklerwerkzeuge einsehbar.
 */
async function request(method, path, body) {
  return invoke('api_request', { method, path, body: body ? JSON.stringify(body) : null });
}

export const getBootstrap = () => request('GET', '/api/bootstrap');
export const getComments = (songId) =>
  request('GET', `/api/comments?songId=${encodeURIComponent(songId)}`);
export const createComment = (comment) => request('POST', '/api/comments', comment);
export const updateComment = (id, patch) => request('PATCH', `/api/comments/${id}`, patch);
export const deleteComment = (id) => request('DELETE', `/api/comments/${id}`);
export const addReaction = (id, emoji) =>
  request('PUT', `/api/reactions/${id}/${encodeURIComponent(emoji)}`);
export const removeReaction = (id, emoji) =>
  request('DELETE', `/api/reactions/${id}/${encodeURIComponent(emoji)}`);

/** ULID, damit ein wiederholter POST nach Netzabbruch nichts doppelt anlegt. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid() {
  let ms = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (const b of bytes) random += CROCKFORD[b % 32];
  return time + random;
}

/**
 * Die API liefert Kommentare flach mit parent_id. Die Darstellung erwartet
 * (noch) verschachtelte replies[] und die alten Feldnamen - das baut hier
 * zusammen. Faellt in Phase 3 weg, wenn der Renderer selbst flach arbeitet.
 */
export function toTree(rows) {
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      versionId: row.version_id,
      parentId: row.parent_id,
      author: row.author,
      text: row.text,
      deleted: !!row.deleted_at,
      anchorType: row.anchor_type,
      start: row.start_s ?? 0,
      end: row.end_s ?? row.start_s ?? 0,
      timestamp: row.created_at,
      tags: row.tags || [],
      reactions: row.reactions || {},
      replies: [],
    });
  }

  const roots = [];
  for (const comment of byId.values()) {
    const parent = comment.parentId ? byId.get(comment.parentId) : null;
    if (parent) parent.replies.push(comment);
    else roots.push(comment);
  }
  for (const comment of byId.values()) {
    comment.replies.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
  return roots;
}

/**
 * Wo spielen wir ab? Liegt die Datei lokal (Drive-Ordner), gewinnt die Platte -
 * kein Download, und es funktioniert auch ohne Netz.
 */
export async function resolveAudio(version) {
  const local = await invoke('local_path_for', { sha256: version.sha256 }).catch(() => null);
  if (local) return { kind: 'local', path: local };
  return { kind: 'remote', path: `/api/audio/${version.id}` };
}

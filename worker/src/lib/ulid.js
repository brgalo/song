// ULID: zeitlich sortierbar, kollisionsfrei ohne Koordination.
// Der Client erzeugt die ID, damit ein wiederholter POST idempotent bleibt.
// Ersetzt die Date.now()-IDs der alten App, bei denen zwei Leute in derselben
// Millisekunde dieselbe ID bekamen.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms, len) {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

export function ulid(ms = Date.now()) {
  return encodeTime(ms, 10) + encodeRandom(16);
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Die Altbestaende aus comments.json tragen Date.now()-Strings bzw.
// Date.now()+Zufallssuffix. Die duerfen ihre ID behalten, damit die Migration
// wiederholbar bleibt - deshalb hier bewusst nicht nur ULIDs akzeptieren.
const LEGACY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && (ULID_RE.test(id) || LEGACY_RE.test(id));
}

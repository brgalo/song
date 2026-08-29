// Ende-zu-Ende-Test gegen einen laufenden `npm run dev`.
//
//   Terminal 1: npm run dev
//   Terminal 2: npm test
//
// Setzt voraus, dass das lokale Schema eingespielt ist (npm run db:init:local)
// und ein Testgeraet existiert (siehe test/seed.sql).

const API = process.env.API ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TOKEN ?? 'test-device-token';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

async function call(method, path, body, token = TOKEN) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* z.B. Audio-Bytes */ }
  return { status: res.status, json, text };
}

// ULIDs muessen pro Lauf frisch sein, sonst schlaegt die Idempotenzpruefung
// beim zweiten Durchlauf fehl (der Kommentar existiert dann schon).
const run = Date.now().toString(36).toUpperCase().padStart(10, '0').slice(-10);
let counter = 0;
const testId = () => `01${run}${String(++counter).padStart(14, '0')}`.slice(0, 26);

console.log('== Auth ==');
check('ohne Token -> 401', (await call('GET', '/api/bootstrap', undefined, null)).status === 401);
check('falsches Token -> 401', (await call('GET', '/api/bootstrap', undefined, 'falsch')).status === 401);

const boot0 = await call('GET', '/api/bootstrap');
check('gueltiges Token -> Identitaet', boot0.json?.identity === 'martin@example.com', JSON.stringify(boot0.json));
check('Band-Konfiguration kommt mit', typeof boot0.json?.bandName === 'string' && boot0.json.bandName.length > 0);

console.log('== Upload ==');
const bytes = new TextEncoder().encode(`audio-${run}`);
const digest = await crypto.subtle.digest('SHA-256', bytes);
const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
const songName = `Testsong ${run}`;

const prep = await call('POST', '/api/upload/prepare', {
  sha256, filename: 'take3.mp3', songName, bytes: bytes.length,
});
check('prepare -> known:false', prep.json?.known === false, JSON.stringify(prep.json));
const versionId = prep.json?.versionId;

check('prepare ohne sha256 -> 400',
  (await call('POST', '/api/upload/prepare', { filename: 'x.mp3', songName, bytes: 5 })).status === 400);
check('prepare mit Riesendatei -> 413',
  (await call('POST', '/api/upload/prepare', { sha256, filename: 'x.wav', songName, bytes: 2 ** 40 })).status === 413);

const put = await fetch(`${API}/api/upload/blob/${versionId}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'audio/mpeg' },
  body: bytes,
});
check('Bytes hochladen', put.ok);
check('complete mit Dauer und Peaks',
  (await call('POST', `/api/upload/complete/${versionId}`, { duration: 212.5, peaks: [[0, 0.5, -0.4, 0.9]] })).json?.ok === true);

console.log('== Dedup ==');
const again = await call('POST', '/api/upload/prepare', {
  sha256, filename: 'kopie.mp3', songName, bytes: bytes.length,
});
check('gleicher Hash -> known:true, kein zweiter Upload', again.json?.known === true, JSON.stringify(again.json));
check('Dedup zeigt auf dieselbe Version', again.json?.versionId === versionId);

console.log('== Bibliothek ==');
const boot = await call('GET', '/api/bootstrap');
const song = boot.json.songs.find((s) => s.name === songName);
check('Song erscheint in der Bibliothek', !!song);
check('Version haengt am Song mit Dauer', song?.versions?.[0]?.duration === 212.5);
const songId = song.id;

const audio = await call('GET', `/api/audio/${versionId}`);
check('Audio wird ausgeliefert', audio.text === `audio-${run}`);
const peaks = await call('GET', `/api/peaks/${versionId}`);
check('Peaks werden ausgeliefert', JSON.stringify(peaks.json) === '[[0,0.5,-0.4,0.9]]');

console.log('== Kommentare ==');
const rootId = testId();
const created = await call('POST', '/api/comments', {
  id: rootId, songId, versionId, anchorType: 'range', startS: 12, endS: 18.5,
  text: 'Gitarre zu laut', tags: ['Gitarre', 'mix'], author: 'Eindringling',
});
check('anlegen -> created:true', created.json?.created === true, JSON.stringify(created.json));
check('Autor kommt aus dem Token, nicht aus dem Body',
  created.json?.comment?.author === 'martin@example.com', JSON.stringify(created.json?.comment));
check('Tags werden kleingeschrieben abgelegt',
  JSON.stringify(created.json?.comment?.tags?.sort()) === '["gitarre","mix"]');

const repeat = await call('POST', '/api/comments', {
  id: rootId, songId, versionId, anchorType: 'range', startS: 12, endS: 18.5, text: 'Gitarre zu laut',
});
check('gleiche ULID nochmal -> created:false (idempotent)', repeat.json?.created === false);

check('endS <= startS -> 400', (await call('POST', '/api/comments',
  { id: testId(), songId, anchorType: 'range', startS: 5, endS: 5, text: 'x' })).status === 400);
check('leerer Text -> 400', (await call('POST', '/api/comments',
  { id: testId(), songId, anchorType: 'none', text: '   ' })).status === 400);
check('unbekannter Song -> 404', (await call('POST', '/api/comments',
  { id: testId(), songId: 'gibtsnicht', anchorType: 'none', text: 'x' })).status === 404);

const pointId = testId();
check('Pin-Kommentar (anchorType point)', (await call('POST', '/api/comments',
  { id: pointId, songId, versionId, anchorType: 'point', startS: 44.2, text: 'hier knackt es' })).json?.created === true);
const songWideId = testId();
check('Kommentar ohne Zeitbezug (anchorType none)', (await call('POST', '/api/comments',
  { id: songWideId, songId, anchorType: 'none', text: 'Song insgesamt zu lang' })).json?.created === true);

const replyId = testId();
check('Antwort haengt an parent_id', (await call('POST', '/api/comments',
  { id: replyId, songId, parentId: rootId, anchorType: 'none', text: 'stimmt' })).json?.created === true);

console.log('== Reaktionen ==');
// Der eigentliche Punkt: frueher fand toggleReaction Antworten gar nicht,
// weil .find() nur die oberste Ebene absuchte.
check('Reaktion auf eine ANTWORT setzen',
  (await call('PUT', `/api/reactions/${replyId}/${encodeURIComponent('🔥')}`)).json?.ok === true);
const withReaction = await call('GET', `/api/comments?songId=${songId}`);
const reply = withReaction.json.comments.find((c) => c.id === replyId);
const others = withReaction.json.comments.filter((c) => c.id !== replyId);
check('Reaktion sitzt an der Antwort',
  JSON.stringify(reply?.reactions) === JSON.stringify({ '🔥': ['martin@example.com'] }),
  JSON.stringify(reply?.reactions));
check('kein anderer Kommentar hat sie faelschlich abbekommen',
  others.every((c) => Object.keys(c.reactions).length === 0));
check('unbekanntes Emoji -> 400',
  (await call('PUT', `/api/reactions/${replyId}/${encodeURIComponent('💀')}`)).status === 400);
check('Reaktion wieder entfernen',
  (await call('DELETE', `/api/reactions/${replyId}/${encodeURIComponent('🔥')}`)).json?.ok === true);

console.log('== Bearbeiten und Tombstone ==');
check('Text aendern',
  (await call('PATCH', `/api/comments/${rootId}`, { text: 'Gitarre deutlich zu laut' })).json?.comment?.text === 'Gitarre deutlich zu laut');
check('loeschen', (await call('DELETE', `/api/comments/${rootId}`)).json?.ok === true);

const normal = await call('GET', `/api/comments?songId=${songId}`);
// rootId traegt eine Antwort, bleibt also absichtlich als Huelle stehen -
// der ausfuehrliche Nachweis dafuer steht weiter unten.
const normalRoot = normal.json.comments.find((c) => c.id === rootId);
check('geloeschter Kommentar behaelt keinen Text in der Normalabfrage',
  normalRoot !== undefined && normalRoot.text === '', JSON.stringify(normalRoot));
const sync = await call('GET', `/api/comments?songId=${songId}&since=1970-01-01T00:00:00.000Z`);
const tombstone = sync.json.comments.find((c) => c.id === rootId);
check('Sync-Abfrage liefert den Tombstone mit', !!tombstone?.deleted_at,
  'ohne ihn wuerde ein Offline-Client den Kommentar spaeter wieder auferstehen lassen');

console.log('== Geloeschter Thread mit Antwort ==');
// Beschlossen: ein geloeschter Root-Kommentar hinterlaesst einen Platzhalter,
// seine Antworten bleiben lesbar. Vorher fiel der Root aus der Normalabfrage
// und nahm die ganze Diskussion mit.
const threadRoot = testId();
const threadReply = testId();
await call('POST', '/api/comments',
  { id: threadRoot, songId, versionId, anchorType: 'point', startS: 90, text: 'Bridge klingt komisch', tags: ['arrangement'] });
await call('POST', '/api/comments',
  { id: threadReply, songId, parentId: threadRoot, anchorType: 'none', text: 'finde ich auch' });
await call('PUT', `/api/reactions/${threadRoot}/${encodeURIComponent('👍')}`);
await call('DELETE', `/api/comments/${threadRoot}`);

const thread = (await call('GET', `/api/comments?songId=${songId}`)).json.comments;
const husk = thread.find((c) => c.id === threadRoot);
const survivor = thread.find((c) => c.id === threadReply);

check('geloeschter Root bleibt als Huelle in der Liste', !!husk,
  'ohne ihn verliert der Client die Verankerung der Antwort');
check('Huelle ist als geloescht markiert', !!husk?.deleted_at);
check('Text der geloeschten Zeile verlaesst den Server nicht', husk?.text === '',
  JSON.stringify(husk?.text));
check('Tags und Reaktionen der geloeschten Zeile ebenfalls nicht',
  JSON.stringify(husk?.tags) === '[]' && JSON.stringify(husk?.reactions) === '{}',
  JSON.stringify({ tags: husk?.tags, reactions: husk?.reactions }));
check('die Antwort bleibt unveraendert lesbar', survivor?.text === 'finde ich auch');

// Gegenprobe: ohne Antwort daran verschwindet ein geloeschter Kommentar ganz.
const lonely = testId();
await call('POST', '/api/comments', { id: lonely, songId, anchorType: 'none', text: 'Tippfehler' });
await call('DELETE', `/api/comments/${lonely}`);
const afterLonely = (await call('GET', `/api/comments?songId=${songId}`)).json.comments;
check('geloeschter Kommentar OHNE Antworten verschwindet ganz',
  !afterLonely.some((c) => c.id === lonely));

console.log('== Abschnitte ==');
const sectionId = testId();
check('Abschnitt anlegen', (await call('POST', '/api/sections',
  { id: sectionId, versionId, type: 'chorus', variant: '2', startS: 40, endS: 68 })).json?.created === true);
check('unbekannter Typ -> 400', (await call('POST', '/api/sections',
  { id: testId(), versionId, type: 'refrain', startS: 1, endS: 2 })).status === 400);
const sectionList = await call('GET', `/api/sections?versionId=${versionId}`);
check('Abschnitt wird gelesen',
  sectionList.json?.sections?.some((s) => s.id === sectionId && s.type === 'chorus' && s.variant === '2'));

console.log('== Feed ==');
const feed = await call('GET', '/api/feed?since=1970-01-01T00:00:00.000Z');
check('Feed meldet die neue Version', feed.json?.versions?.some((v) => v.song_name === songName));
check('Feed ab jetzt leer', (await call('GET', '/api/feed?since=2099-01-01T00:00:00.000Z')).json?.versions?.length === 0);

console.log('== Router ==');
check('unbekannte Route -> 404', (await call('GET', '/api/gibtsnicht')).status === 404);
check('falsche Methode -> 405', (await call('DELETE', '/api/bootstrap')).status === 405);

console.log(`\n${passed} bestanden, ${failures.length} fehlgeschlagen`);
if (failures.length) {
  console.log('Fehlgeschlagen:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}

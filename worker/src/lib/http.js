// Kleine HTTP-Helfer. Alle Antworten sind JSON, alle Fehler haben dieselbe Form.

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

/** Fehler, den der Router in eine saubere JSON-Antwort verwandelt. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg) => new HttpError(401, 'unauthorized', msg);
export const notFound = (msg) => new HttpError(404, 'not_found', msg);
export const conflict = (msg) => new HttpError(409, 'conflict', msg);
export const tooLarge = (msg) => new HttpError(413, 'too_large', msg);

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message }, { status: err.status });
  }
  console.error('Unbehandelter Fehler:', err && err.stack ? err.stack : err);
  return json({ error: 'internal', message: 'Interner Fehler' }, { status: 500 });
}

/** Liest den Body als JSON und wirft sauber, statt einen 500er zu produzieren. */
export async function readJson(request) {
  try {
    const body = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('Body muss ein JSON-Objekt sein');
    }
    return body;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest('Body ist kein gueltiges JSON');
  }
}

export const nowIso = () => new Date().toISOString();

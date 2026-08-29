// songou-api — Einstiegspunkt.
//
// Auf diesem Worker liegt bewusst KEIN Cloudflare Access: die Desktop-App
// schickt Bearer-Tokens, und Access wuerde die in einen Login-Redirect
// umleiten. Stattdessen prueft jede Route selbst (siehe lib/auth.js).

import { Router } from './lib/router.js';
import { authenticate } from './lib/auth.js';
import { json, errorResponse } from './lib/http.js';
import * as upload from './routes/upload.js';
import * as library from './routes/library.js';
import * as comments from './routes/comments.js';
import * as reactions from './routes/reactions.js';
import * as sections from './routes/sections.js';

// Bearer-Token statt Cookies, deshalb ist "*" hier unproblematisch: ohne
// credentials schickt kein fremder Ursprung das Access-Cookie mit.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, cf-access-jwt-assertion',
  'access-control-max-age': '86400',
};

/** Jede Route laeuft authentifiziert - identity kommt aus dem Token, nie aus dem Body. */
function guarded(handler) {
  return async (ctx) => {
    const identity = await authenticate(ctx.request, ctx.env, ctx.ctx);
    return handler({ ...ctx, identity });
  };
}

const router = new Router()
  .get('/api/bootstrap', guarded(library.bootstrap))
  .get('/api/feed', guarded(library.feed))

  .post('/api/upload/prepare', guarded(upload.prepare))
  .put('/api/upload/blob/:versionId', guarded(upload.uploadBlob))
  .post('/api/upload/complete/:versionId', guarded(upload.complete))

  .get('/api/audio/:versionId', guarded(library.audio))
  .get('/api/peaks/:versionId', guarded(library.peaks))

  .get('/api/comments', guarded(comments.list))
  .post('/api/comments', guarded(comments.create))
  .patch('/api/comments/:id', guarded(comments.update))
  .delete('/api/comments/:id', guarded(comments.remove))

  .put('/api/reactions/:commentId/:emoji', guarded(reactions.add))
  .delete('/api/reactions/:commentId/:emoji', guarded(reactions.remove))

  .get('/api/sections', guarded(sections.list))
  .post('/api/sections', guarded(sections.create))
  .patch('/api/sections/:id', guarded(sections.update))
  .delete('/api/sections/:id', guarded(sections.remove))

  .get('/api/health', () => json({ ok: true }));

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    let response;
    try {
      response = await router.handle(request, env, ctx);
    } catch (err) {
      response = errorResponse(err);
    }

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

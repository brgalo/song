// Winziger Router. Kein Framework noetig - es sind zwei Dutzend Routen, und
// jede Abhaengigkeit weniger ist eine Abhaengigkeit weniger im Free-Plan-Bundle.

import { errorResponse, notFound, HttpError } from './http.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  /** Pfadmuster wie "/api/comments/:id"; :param landet in ctx.params. */
  add(method, pattern, handler) {
    const names = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, name) => {
          names.push(name);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, regex, names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    let pathMatched = false;

    for (const route of this.routes) {
      const m = route.regex.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;

      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      try {
        return await route.handler({ request, env, ctx, url, params });
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (pathMatched) {
      return errorResponse(new HttpError(405, 'method_not_allowed', 'Methode nicht erlaubt'));
    }
    return errorResponse(notFound('Unbekannte Route'));
  }
}

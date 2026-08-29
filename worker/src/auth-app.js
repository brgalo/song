// songou-auth — die Kopplungsseite, und sonst nichts.
//
// Auf DIESEN Worker gehoert Cloudflare Access. Er sieht ausschliesslich
// Browser-Traffic, deshalb funktioniert der Login-Redirect hier. Wer eingeloggt
// ist, kann sich ein Geraetetoken ausstellen lassen und es in die Desktop-App
// eintragen - damit kommt die native App an eine verifizierte Identitaet,
// ohne selbst einen Login-Flow zu koennen.

import { verifyAccessJwt, createDeviceToken, cookieValue } from './lib/auth.js';
import { json, errorResponse, unauthorized, readJson } from './lib/http.js';

async function identityOf(request, env) {
  const token =
    request.headers.get('cf-access-jwt-assertion') ||
    cookieValue(request.headers.get('cookie'), 'CF_Authorization');
  if (!token) throw unauthorized('Diese Seite muss hinter Cloudflare Access liegen');
  return verifyAccessJwt(token, env);
}

function page(identity) {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>songou — Gerät koppeln</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#141414; color:#f0f0f0;
         font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .card { width:min(560px, 92vw); background:#1e1e1e; border:1px solid #333;
          border-radius:12px; padding:28px 30px; }
  h1 { margin:0 0 4px; font-size:1.1rem; color:#4ade80;
       font-family: ui-monospace, 'Cascadia Code', monospace; letter-spacing:.05em; }
  p { color:#888; font-size:.9rem; line-height:1.55; }
  button { background:#4ade80; color:#000; border:0; border-radius:6px;
           padding:10px 20px; font-weight:700; cursor:pointer; font-size:.85rem; }
  button:hover { opacity:.87; }
  button:disabled { opacity:.5; cursor:default; }
  code#token { display:block; margin-top:16px; padding:14px; background:#141414;
               border:1px solid #333; border-radius:6px; word-break:break-all;
               font-family: ui-monospace, monospace; font-size:.82rem; color:#4ade80; }
  .warn { color:#fbbf24; font-size:.82rem; margin-top:14px; }
  .hidden { display:none; }
</style></head>
<body><div class="card">
  <h1>GERÄT KOPPELN</h1>
  <p>Angemeldet als <strong>${identity.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</strong>.
     Erzeuge ein Token und trage es einmalig in der Desktop-App ein.</p>
  <button id="go">Token erzeugen</button>
  <code id="token" class="hidden"></code>
  <p class="warn hidden" id="warn">Das Token wird nur jetzt angezeigt. Wer es hat, kommentiert in deinem Namen.</p>
<script>
  const btn = document.getElementById('go');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Erzeuge…';
    try {
      const res = await fetch('/pair/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: navigator.platform || 'Desktop' }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const el = document.getElementById('token');
      el.textContent = data.token;
      el.classList.remove('hidden');
      document.getElementById('warn').classList.remove('hidden');
      btn.textContent = 'Weiteres Token erzeugen';
    } catch (err) {
      btn.textContent = 'Fehlgeschlagen — nochmal versuchen';
    } finally {
      btn.disabled = false;
    }
  });
</script>
</div></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/pair') {
        const identity = await identityOf(request, env);
        return new Response(page(identity), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      if (url.pathname === '/pair/token' && request.method === 'POST') {
        const identity = await identityOf(request, env);
        const body = await readJson(request).catch(() => ({}));
        const token = await createDeviceToken(env, identity, body.label);
        return json({ token, identity });
      }

      return json({ error: 'not_found' }, { status: 404 });
    } catch (err) {
      return errorResponse(err);
    }
  },
};

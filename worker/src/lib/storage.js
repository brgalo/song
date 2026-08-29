// R2 kostet ab 10 GB Geld, und Cloudflare kennt keine harte Ausgabengrenze.
// Deshalb bremst der Server selbst, bevor das Freikontingent ausgeht.
// Der Wert steht in settings und laesst sich ohne Deploy anheben.

const DEFAULT_LIMIT_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB, Puffer bis 10 GB

export async function storageLimitBytes(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'storage_limit_bytes'").first();
  if (!row) return DEFAULT_LIMIT_BYTES;
  const parsed = Number(JSON.parse(row.value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT_BYTES;
}

export async function usedBytes(env) {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(bytes), 0) AS total FROM versions WHERE deleted_at IS NULL',
  ).first();
  return Number(row?.total ?? 0);
}

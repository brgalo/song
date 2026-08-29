-- Testgeraet fuer den lokalen Smoke-Test.
-- token_hash ist SHA-256 von 'test-device-token'.
INSERT OR REPLACE INTO devices (token_hash, identity, label, created_at) VALUES
  ('fdc2f4194f79710d879d596f606d94f5e85f07f53b42d2b13f2e9aeb74d78c39',
   'martin@example.com', 'Testrechner', '2026-01-01T00:00:00.000Z');

-- Kleines Speicherlimit NUR fuer die lokale Testdatenbank (50 MiB), damit die
-- Speicherbremse pruefbar ist, ohne 8 GB hochzuladen. In der echten D1 gilt
-- weiter der Vorgabewert aus lib/storage.js.
INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('storage_limit_bytes', '52428800', '2026-01-01T00:00:00.000Z');

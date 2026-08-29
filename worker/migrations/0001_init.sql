-- songou — Ausgangsschema.
-- Konventionen:
--   * IDs sind ULIDs (26 Zeichen, Crockford-Base32), vom CLIENT erzeugt.
--     Dadurch ist jedes POST idempotent: ein Retry nach Netzabbruch legt
--     dank INSERT OR IGNORE nichts doppelt an.
--   * Zeitstempel sind ISO-8601-Strings in UTC.
--   * Es wird nie hart geloescht. deleted_at ist ein Tombstone, damit ein
--     spaeterer Offline-Sync geloeschte Zeilen nicht wieder auferstehen laesst.
--   * updated_at ist der Last-Write-Wins-Schluessel.

CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,          -- Ordnername unter pre_pro
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
-- Ein Songname existiert nur einmal, solange er nicht geloescht ist.
CREATE UNIQUE INDEX IF NOT EXISTS songs_name_live
  ON songs(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS versions (
  id          TEXT PRIMARY KEY,
  song_id     TEXT NOT NULL REFERENCES songs(id),
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL UNIQUE,   -- Dedup-Schluessel ueber alle Agents
  bytes       INTEGER NOT NULL,
  duration    REAL,                   -- Sekunden, kommt erst mit upload/complete
  r2_key      TEXT NOT NULL,
  peaks_key   TEXT,
  ready       INTEGER NOT NULL DEFAULT 0,  -- 1 = Audio liegt vollstaendig in R2
  uploaded_by TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS versions_song ON versions(song_id);
CREATE INDEX IF NOT EXISTS versions_feed ON versions(created_at);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  song_id     TEXT NOT NULL REFERENCES songs(id),
  version_id  TEXT REFERENCES versions(id),  -- NULL = gilt fuer den ganzen Song
  parent_id   TEXT REFERENCES comments(id),  -- NULL = Root, sonst Antwort
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('range', 'point', 'none')),
  start_s     REAL,
  end_s       REAL,
  author      TEXT NOT NULL,          -- verifizierte Identitaet, nie Client-Angabe
  text        TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS comments_sync ON comments(updated_at);
CREATE INDEX IF NOT EXISTS comments_song ON comments(song_id, version_id);
CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id);

CREATE TABLE IF NOT EXISTS comment_tags (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  tag        TEXT NOT NULL,
  PRIMARY KEY (comment_id, tag)
);
CREATE INDEX IF NOT EXISTS comment_tags_tag ON comment_tags(tag);

CREATE TABLE IF NOT EXISTS reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  author     TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, author, emoji)
);

CREATE TABLE IF NOT EXISTS sections (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  start_s    REAL NOT NULL,
  end_s      REAL NOT NULL,
  type       TEXT NOT NULL,
  variant    TEXT,
  label      TEXT,
  color      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS sections_version ON sections(version_id);

CREATE TABLE IF NOT EXISTS devices (
  token_hash TEXT PRIMARY KEY,        -- SHA-256 hex, nie das Token selbst
  identity   TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS devices_identity ON devices(identity);

-- Band-Konfiguration (ersetzt config.json). Wert ist jeweils JSON.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('band_name', '"Andy Revive"', '1970-01-01T00:00:00.000Z'),
  ('members', '{"Flip \"Dr. Djent\"":"#4ade80","Benjam":"#f59e0b","Danger Dimi":"#ef4444","Goldjunge":"#a855f7","Bruder G#":"#f472b6"}', '1970-01-01T00:00:00.000Z'),
  ('tags', '["gitarre","bass","drums","vocals","mix","arrangement"]', '1970-01-01T00:00:00.000Z');

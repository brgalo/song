# songou-worker

Die API hinter der Desktop-App: Kommentare, Abschnitte und die Songbibliothek
liegen in **D1**, das Audio in **R2**. Zwei Worker, weil Cloudflare Access am
ganzen Worker haengt:

| Worker | Access | Aufgabe |
|---|---|---|
| `songou-api` | **aus** | Die API. Prueft selbst — Access-JWT *oder* Geraetetoken. |
| `songou-auth` | **an** | Nur die Kopplungsseite `/pair`. Sieht ausschliesslich Browser. |

Warum getrennt: Die Desktop-App schickt `Authorization: Bearer …`. Laege Access
auf der API, wuerde Cloudflare diese Requests in einen Login-Redirect umleiten,
den ein `fetch()` nicht interaktiv beantworten kann.

## Lokal entwickeln

```bash
npm install
npm run db:init:local     # Schema in die lokale D1
npm run db:seed:local     # Testgeraet mit Token 'test-device-token'
npm run dev               # Terminal 1
npm test                  # Terminal 2 — 41 Ende-zu-Ende-Pruefungen
```

Der Test ist beliebig oft wiederholbar; er erzeugt pro Lauf frische ULIDs.

## Einmalig einrichten (Cloudflare)

```bash
npx wrangler d1 create songou            # database_id in beide wrangler-*.toml
npx wrangler r2 bucket create songou-audio
npm run db:init                          # Schema in die echte D1
npm run deploy && npm run deploy:auth
```

Danach im Zero-Trust-Dashboard:

1. Access auf **`songou-auth`** legen (One-Click bei den Worker-Einstellungen),
   Policy = die Mailadressen der Band.
2. `ACCESS_TEAM_DOMAIN` und `ACCESS_AUD` in **beiden** `wrangler-*.toml` eintragen
   (Team-Domain steht unter Settings → Custom Pages, das AUD-Tag bei der
   Access-Anwendung).
3. Sicherstellen, dass auf **`songou-api` kein Access liegt** — sonst kommt die
   Desktop-App nicht durch.

Ein Geraet koppeln: `https://songou-auth.<subdomain>.workers.dev/pair` im Browser
oeffnen, einloggen, Token erzeugen, in der Desktop-App eintragen.

## Datenmodell — die drei Regeln

- **IDs erzeugt der Client** (ULID). Deshalb ist jedes `POST` idempotent: ein
  Retry nach Netzabbruch legt dank `INSERT OR IGNORE` nichts doppelt an.
- **Nie hart loeschen.** `deleted_at` ist ein Tombstone. Ohne ihn holt ein
  spaeterer Offline-Sync geloeschte Kommentare wieder zurueck.
- **`updated_at` ist der Last-Write-Wins-Schluessel.** `?since=` liefert alles
  Geaenderte inklusive Tombstones — die Grundlage fuer den spaeteren Offline-Sync.

Der Autor eines Kommentars kommt **immer** aus dem verifizierten Token, nie aus
dem Request-Body.

## Endpunkte

```
GET    /api/bootstrap                      Band-Config + komplette Bibliothek
GET    /api/feed?since=                    neue Versionen (Benachrichtigung)

POST   /api/upload/prepare                 {sha256,filename,songName,bytes}
                                           -> {known:true} | {versionId, uploadPath}
PUT    /api/upload/blob/:versionId         die Bytes
POST   /api/upload/complete/:versionId     {duration, peaks}

GET    /api/audio/:versionId               unterstuetzt Range-Requests
GET    /api/peaks/:versionId

GET    /api/comments?songId=&since=
POST   /api/comments                       id (ULID) muss im Body stehen
PATCH  /api/comments/:id
DELETE /api/comments/:id                   setzt deleted_at

PUT    /api/reactions/:commentId/:emoji
DELETE /api/reactions/:commentId/:emoji

GET    /api/sections?versionId=&since=
POST   /api/sections
PATCH  /api/sections/:id
DELETE /api/sections/:id
```

## Upload: durch den Worker statt per presigned URL

Der Plan sah Direktuploads an R2 per presigned URL vor — begruendet mit dem
100-MB-Body-Limit der Workers. Mit der Entscheidung fuer VBR0-MP3s (~7 MB pro
Song) greift diese Begruendung nicht mehr, und der einfachere Weg spart die
R2-S3-Zugangsdaten, `aws4fetch` und eine CORS-Konfiguration am Bucket.

`prepare` weist deshalb Dateien ueber 90 MB mit einer verstaendlichen Meldung ab,
statt sie am Plattformlimit auflaufen zu lassen. Sollten doch einmal lange WAVs
noetig werden, ist der Wechsel klein: nur `uploadBlob` in `src/routes/upload.js`
muss dann eine signierte URL zurueckgeben statt die Bytes selbst anzunehmen.

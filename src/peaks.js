// Peak-Berechnung fuer den Sync-Agent.
//
// Rust schickt compute-peaks, wir liefern peaks_ready zurueck. Kein
// WaveSurfer noetig: decodeAudioData gibt Kanaele und Dauer direkt her, und
// das Ergebnis hat genau das Format, das WaveSurfer beim Laden erwartet
// (load(url, peaks, duration)).


// Ein Wert pro Bucket. 8000 reicht fuer eine scharfe Wellenform ueber die
// volle Fensterbreite und bleibt als JSON im niedrigen dreistelligen
// Kilobyte-Bereich - der eigentliche Sinn der Sache, damit ein Client die
// Wellenform zeichnen kann, ohne das Audio zu laden.
const BUCKETS = 8000;

/**
 * Fasst einen Kanal auf BUCKETS Werte zusammen.
 *
 * Pro Bucket gewinnt der Ausschlag mit dem groessten Betrag, und zwar
 * MIT Vorzeichen. Nimmt man nur den Betrag, sieht die Wellenform
 * gleichgerichtet aus - oben und unten identisch, was bei asymmetrischem
 * Material schlicht falsch ist.
 */
export function downsample(channel, buckets) {
  const size = Math.max(1, Math.floor(channel.length / buckets));
  const out = new Array(buckets);

  for (let i = 0; i < buckets; i++) {
    const start = i * size;
    const end = Math.min(start + size, channel.length);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const value = channel[j];
      if (Math.abs(value) > Math.abs(peak)) peak = value;
    }
    // Auf vier Nachkommastellen runden: der Unterschied ist unsichtbar, die
    // JSON-Datei wird dadurch aber ungefaehr halb so gross.
    out[i] = Math.round(peak * 10000) / 10000;
  }
  return out;
}

// Im Browserfenster verdrahten; unter Node (Test) gibt es kein __TAURI__.
const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
if (tauri) wire(tauri.core.invoke, tauri.event.listen);

function wire(invoke, listen) {
  listen('compute-peaks', async (event) => {
    const { versionId, path } = event.payload;
    let context;
    try {
      const bytes = await invoke('load_audio_file', { path });
      const buffer = new Uint8Array(bytes).buffer;

      context = new AudioContext();
      const audio = await context.decodeAudioData(buffer);

      const channels = [];
      for (let c = 0; c < audio.numberOfChannels; c++) {
        channels.push(downsample(audio.getChannelData(c), BUCKETS));
      }

      await invoke('peaks_ready', {
        versionId,
        duration: audio.duration,
        peaks: channels,
      });
    } catch (err) {
      console.error('Peaks fehlgeschlagen fuer', path, err);
      // Bewusst keine Antwort: der Rust-Teil laeuft in seinen Timeout, die
      // Version bleibt auf ready = 0 stehen und der naechste Versuch macht
      // an derselben Stelle weiter.
    } finally {
      // AudioContexts sind eine begrenzte Ressource. Ohne close() ist nach ein
      // paar Dutzend Songs Schluss.
      if (context) await context.close().catch(() => {});
    }
  });
}

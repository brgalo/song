import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';
import RegionsPlugin from 'https://unpkg.com/wavesurfer.js@7/dist/plugins/regions.esm.js';
import * as api from './api.js';

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

window.addEventListener("DOMContentLoaded", async () => {
  const outputDiv = document.getElementById("app");
  const playButton = document.getElementById("play-btn");
  const currentSongTitle = document.getElementById("current-song-title");
  const folderList = document.getElementById("folder-list");

  let currentConfig = { band_name: "Unbekannte Band", current_user: "Gast", members: {} };
  let currentSongId = "";
  let currentVersionId = "";
  let currentVersionName = "";
  let allFolderComments = [];

  // --- State ---
  let activeRegion = null;       // Die Region, die zum Kommentieren gerade gezogen wurde
  let activeLoopRegion = null;   // commentId der aktiven Loop-Region (kein Objekt!)
  let isLooping = false;
  let sortMode = "time";         // "time" | "date" | "replies"
  let sortDir = 1;               // 1 = aufsteigend, -1 = absteigend
  let searchQuery = "";
  window.renderedRegions = {};
  // Merkt sich alle gespeicherten Regions separat vom clearRegions()-Problem
  window.savedRegionIds = new Set();

  // --- Farb-Hilfsfunktion ---
  function memberColor(author) {
    return currentConfig.members?.[author] || "#888888";
  }

  // --- Highlight-Funktionen ---
  window.highlightRegion = function(id) {
    const r = window.renderedRegions[id];
    if (r?.element) {
      r.element.style.filter = 'brightness(2.2)';
      r.element.style.zIndex = '10';
    }
    const box = document.getElementById(`comment-box-${id}`);
    if (box) box.classList.add('comment-highlight');
  };

  window.unhighlightRegion = function(id) {
    const r = window.renderedRegions[id];
    if (r?.element) {
      r.element.style.filter = 'none';
      r.element.style.zIndex = '1';
    }
    const box = document.getElementById(`comment-box-${id}`);
    if (box) box.classList.remove('comment-highlight');
  };

  // --- Zeit-Formatting ---
  function formatTime(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    return d.toLocaleDateString('de-DE') + ", " + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + " Uhr";
  }

  function formatSeconds(s) {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, '0');
    return m > 0 ? `${m}:${sec}` : `${sec}s`;
  }

  // --- Rekursive Suche ---
  function findCommentById(arr, id) {
    for (let c of arr) {
      if (c.id === id) return c;
      if (c.replies?.length) {
        const found = findCommentById(c.replies, id);
        if (found) return found;
      }
    }
    return null;
  }

  // --- Fuzzy Search: gibt true zurück wenn query im text vorkommt (tolerant) ---
  function fuzzyMatch(text, query) {
    if (!query) return true;
    const t = text.toLowerCase();
    const q = query.toLowerCase();
    let ti = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const found = t.indexOf(q[qi], ti);
      if (found === -1) return false;
      ti = found + 1;
    }
    return true;
  }

  function commentMatchesSearch(comment) {
    if (!searchQuery) return true;
    if (fuzzyMatch(comment.text, searchQuery)) return true;
    if (fuzzyMatch(comment.author, searchQuery)) return true;
    if (comment.replies?.some(r => fuzzyMatch(r.text, searchQuery) || fuzzyMatch(r.author, searchQuery))) return true;
    return false;
  }

  // --- Reactions ---
  const REACTIONS = ["👍", "❤️", "🔥", "😂", "😮"];

  function getReactionCounts(comment) {
    const counts = {};
    REACTIONS.forEach(r => counts[r] = 0);
    if (comment.reactions) {
      for (const [emoji, users] of Object.entries(comment.reactions)) {
        if (counts[emoji] !== undefined) counts[emoji] = users.length;
      }
    }
    return counts;
  }

  function hasUserReacted(comment, emoji) {
    return comment.reactions?.[emoji]?.includes(currentConfig.current_user) || false;
  }

  // --- HTML-Generierung ---
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Zeitangabe je nach Verankerung. */
  function anchorBadge(comment) {
    if (comment.anchorType === 'point') {
      return `<span class="time-badge">📍 ${formatSeconds(comment.start)}</span>`;
    }
    if (comment.anchorType === 'range') {
      return `<span class="time-badge">${formatSeconds(comment.start)} – ${formatSeconds(comment.end)}</span>`;
    }
    return `<span class="time-badge">🎵 ganzer Song</span>`;
  }

  function generateCommentHTML(comment, depth = 0, rootId = null) {
    const color = memberColor(comment.author);
    const isRoot = depth === 0;
    const currentRootId = isRoot ? comment.id : rootId;
    const timeStr = formatTime(comment.timestamp);
    const isMine = comment.author === currentConfig.current_user;

    // Geloeschte Kommentare bleiben als Huelle stehen, solange Antworten daran
    // haengen - sonst verschwaende die Diskussion darunter. Der Server liefert
    // Text, Tags und Reaktionen dafuer gar nicht erst aus.
    if (comment.deleted) {
      return `
        <div id="comment-box-${comment.id}" class="${isRoot ? 'comment-box' : 'reply-box'}"
             style="border-left: ${isRoot ? '4px' : '2px'} solid var(--text-dimmer); opacity:.65;">
          <div class="comment-text" style="font-style:italic;color:var(--text-dimmer)">Kommentar gelöscht</div>
          ${(comment.replies?.length > 0) ? comment.replies.map(r => generateCommentHTML(r, depth + 1, currentRootId)).join('') : ''}
        </div>`;
    }

    // Reaktionen nur auf Root-Kommentaren anzeigen.
    let reactionsHTML = '';
    if (isRoot) {
      const counts = getReactionCounts(comment);
      reactionsHTML = `<div class="reactions-row">${REACTIONS.map(emoji => {
        const count = counts[emoji];
        const active = hasUserReacted(comment, emoji);
        return `<button class="reaction-btn ${active ? 'reacted' : ''}"
          onclick="toggleReaction('${comment.id}', '${emoji}')" title="${emoji}">
          ${emoji}${count > 0 ? `<span class="reaction-count">${count}</span>` : ''}
        </button>`;
      }).join('')}</div>`;
    }

    // Bearbeiten und Löschen nur für eigene Kommentare - die API weist fremde
    // Änderungen ohnehin ab, aber die Knöpfe gar nicht erst anzubieten ist
    // ehrlicher als eine Fehlermeldung hinterher.
    const actions = `<div class="comment-actions">
        ${comment.anchorType !== 'none' ? `<button class="icon-btn" onclick="seekToRegion('${comment.id}')" title="Zur Stelle springen">⏮</button>` : ''}
        ${isMine ? `<button class="icon-btn" onclick="editComment('${comment.id}')" title="Bearbeiten">✏️</button>` : ''}
        ${isMine ? `<button class="icon-btn" onclick="removeComment('${comment.id}')" title="Löschen">🗑</button>` : ''}
      </div>`;

    const tagsHTML = comment.tags?.length
      ? `<div class="reactions-row">${comment.tags.map(t =>
          `<span class="time-badge">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    return `
      <div id="comment-box-${comment.id}"
           class="${isRoot ? 'comment-box' : 'reply-box'}"
           style="border-left: ${isRoot ? '4px' : '2px'} solid ${color};"
           onmouseenter="highlightRegion('${currentRootId}')"
           onmouseleave="unhighlightRegion('${currentRootId}')">
        <div style="position: relative;">
          ${actions}
          <strong style="color: ${color}">${escapeHtml(comment.author)}</strong>
          ${isRoot ? anchorBadge(comment) : ''}
          <span class="timestamp-label">${timeStr}</span>
          <div class="comment-text">${escapeHtml(comment.text)}</div>
        </div>
        ${tagsHTML}
        ${reactionsHTML}
        ${(comment.replies?.length > 0) ? comment.replies.map(r => generateCommentHTML(r, depth + 1, currentRootId)).join('') : ''}
        <div class="reply-row">
          <input type="text" id="reply-input-${comment.id}"
                 placeholder="Antworten… (Enter)"
                 class="reply-input"
                 onkeydown="checkReplyEnter(event, '${comment.id}')">
        </div>
      </div>`;
  }

  // --- EINRICHTUNG UND KONFIGURATION ---
  // Beides kommt jetzt aus der API. Der Benutzername insbesondere: er ist die
  // von Cloudflare Access verifizierte Identitaet, nicht mehr frei waehlbar.
  let songs = [];

  async function loadBootstrap() {
    const data = await api.getBootstrap();
    currentConfig.band_name = data.bandName;
    currentConfig.members = data.members || {};
    currentConfig.current_user = data.identity;
    songs = data.songs || [];
    return data;
  }

  // Header rendern. Das frühere "Du bist:"-Dropdown ist weg: die Identität
  // kommt verifiziert aus dem Token, niemand kann mehr in fremdem Namen
  // kommentieren.
  function renderHeader() {
    const escape = (value) => String(value).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    outputDiv.innerHTML = `
      <div class="band-header">
        <h2 class="band-title">${escape(currentConfig.band_name)}</h2>
        <div class="user-select-wrap">
          <span class="user-prefix">● Du bist:</span>
          <span class="user-select" style="color:${memberColor(currentConfig.current_user)}">${escape(currentConfig.current_user)}</span>
        </div>
      </div>`;
  }


  // --- WAVESURFER ---
  const wsRegions = RegionsPlugin.create();
  const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#4ade80',
    progressColor: '#16a34a',
    cursorColor: '#ffffff',
    barWidth: 2,
    barGap: 1,
    height: 100,
    plugins: [wsRegions]
  });

  wsRegions.enableDragSelection({ color: 'rgba(255, 255, 255, 0.15)' });

  // Neue Region gezogen → als activeRegion merken (temporär)
  wsRegions.on('region-created', (region) => {
    // Nur temp-Regionen (vom User gerade gezogen) behandeln
    if (region.data?.saved) return;
    // Vorherige temp-Region entfernen
    if (activeRegion?.id?.startsWith('temp_')) {
      try { activeRegion.remove(); } catch {}
    }
    region.id = 'temp_' + Date.now();
    activeRegion = region;
    document.getElementById("comment-input").focus();
  });

  // Region angeklickt → Kommentar scrollen + Loop-Bereich merken
  wsRegions.on('region-clicked', (region, e) => {
    e.stopPropagation();
    if (!region.data?.saved) return;

    // commentId aus data holen (zuverlässiger als region.id nach Re-render)
    const commentId = region.data.commentId || region.id;

    // Kommentar ins Bild scrollen
    const box = document.getElementById(`comment-box-${commentId}`);
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Cursor zur Region springen, Play-Status beibehalten
    const wasPlaying = wavesurfer.isPlaying();
    wavesurfer.seekTo(region.start / wavesurfer.getDuration());
    if (wasPlaying) wavesurfer.play();

    // Nur die ID merken – nicht das Objekt (wird bei renderComments neu erstellt)
    activeLoopRegion = commentId;
    updateLoopIndicator();
  });

  // Hilfsfunktion: aktuelle Loop-Region frisch aus renderedRegions holen
  function getLoopRegion() {
    if (!activeLoopRegion) return null;
    return window.renderedRegions[activeLoopRegion] || null;
  }

  // Loop-Logik: bei Zeitupdate prüfen
  wavesurfer.on('timeupdate', (currentTime) => {
    if (!isLooping) return;
    const r = getLoopRegion();
    if (r && currentTime >= r.end) {
      wavesurfer.seekTo(r.start / wavesurfer.getDuration());
    }
  });

  // Loop-Indicator aktualisieren
  function updateLoopIndicator() {
    const indicator = document.getElementById('loop-indicator');
    const loopBtn = document.getElementById('loop-btn');
    const r = getLoopRegion();
    if (r) {
      indicator.textContent = `${formatSeconds(r.start)} – ${formatSeconds(r.end)}`;
      indicator.style.display = 'inline';
    } else {
      indicator.style.display = 'none';
    }
    if (loopBtn) {
      loopBtn.classList.toggle('loop-active', isLooping && !!r);
    }
  }

  // Play/Pause Button
  playButton.addEventListener('click', () => {
    wavesurfer.playPause();
  });

  // Loop-Toggle Button
  document.getElementById('loop-btn').addEventListener('click', () => {
    const r = getLoopRegion();
    if (!r) return; // Noch keine Region angeklickt → noop
    isLooping = !isLooping;
    if (isLooping) {
      wavesurfer.seekTo(r.start / wavesurfer.getDuration());
      wavesurfer.play();
    }
    updateLoopIndicator();
  });

  // Volume Slider
  document.getElementById('volume-slider').addEventListener('input', (e) => {
    wavesurfer.setVolume(parseFloat(e.target.value));
    document.getElementById('volume-label').textContent = Math.round(e.target.value * 100) + '%';
  });

  // Loop Stop Button
  document.getElementById('loop-stop-btn').addEventListener('click', () => {
    isLooping = false;
    activeLoopRegion = null;
    updateLoopIndicator();
  });

  // Neuen Hauptkommentar speichern via Enter
  document.getElementById("comment-input").addEventListener("keydown", async (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target;
    const text = input.value.trim();

    if (!text || !activeRegion) {
      const hint = document.getElementById('comment-hint');
      hint.style.opacity = '1';
      setTimeout(() => hint.style.opacity = '0', 2500);
      return;
    }

    // ULID statt Date.now(): zwei Leute in derselben Millisekunde erzeugten
    // frueher dieselbe ID. Ausserdem macht die vom Client vergebene ID den
    // POST idempotent.
    const commentId = api.ulid();
    activeRegion.id = commentId;
    activeRegion.setOptions({
      drag: false,
      resize: false,
      color: memberColor(currentConfig.current_user) + "80",
      data: { saved: true }
    });
    window.renderedRegions[commentId] = activeRegion;

    // Region-Events binden
    activeRegion.on('over', () => window.highlightRegion(commentId));
    activeRegion.on('leave', () => window.unhighlightRegion(commentId));

    const newComment = {
      id: commentId,
      version: currentVersionName,
      author: currentConfig.current_user,
      text,
      start: activeRegion.start,
      end: activeRegion.end,
      timestamp: new Date().toISOString(),
      reactions: {},
      replies: []
    };

    activeRegion = null;
    input.value = "";

    try {
      await api.createComment({
        id: commentId,
        songId: currentSongId,
        versionId: currentVersionId,
        anchorType: "range",
        startS: newComment.start,
        endS: newComment.end,
        text,
      });
    } catch (err) {
      console.error("Kommentar konnte nicht gespeichert werden:", err);
      alert("Kommentar konnte nicht gespeichert werden: " + err);
    }
    await reloadComments();
    renderComments();
  });

  // --- AUDIO LADEN ---
  // Liegt die Datei lokal im Drive-Ordner, gewinnt die Platte: kein Download,
  // sofort da, und es funktioniert auch ohne Netz. Erst wenn sie fehlt (anderer
  // Rechner, kein Drive-Sync), kommt sie aus R2.
  async function loadVersion(song, version) {
    try {
      currentSongTitle.textContent = "⏳ Lade: " + version.filename + "…";
      document.getElementById('waveform').classList.add('loading');
      document.getElementById('comments-list').innerHTML =
        '<p class="no-comments loading-pulse">Lade Kommentare…</p>';

      currentSongId = song.id;
      currentVersionId = version.id;
      currentVersionName = version.filename;

      const source = await api.resolveAudio(version);
      const bytes = source.kind === 'local'
        ? await invoke('load_audio_file', { path: source.path })
        : await invoke('fetch_audio', { versionId: version.id });

      const ext = version.filename.split('.').pop().toLowerCase();
      const blob = new Blob([new Uint8Array(bytes)], {
        type: ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
      });

      wsRegions.clearRegions();
      window.renderedRegions = {};
      window.savedRegionIds.clear();
      activeRegion = null;
      activeLoopRegion = null;
      isLooping = false;
      updateLoopIndicator();
      document.getElementById("comment-ui").style.display = "block";

      wavesurfer.load(URL.createObjectURL(blob));
      await reloadComments();

      wavesurfer.once('ready', () => {
        currentSongTitle.textContent =
          (source.kind === 'local' ? "▶ " : "☁ ") + version.filename;
        document.getElementById('waveform').classList.remove('loading');
        renderComments();
      });
    } catch (error) {
      console.error("Fehler beim Laden:", error);
      currentSongTitle.textContent = "⚠ Fehler beim Laden!";
      document.getElementById('waveform').classList.remove('loading');
    }
  }

  // --- KOMMENTARE RENDERN ---
  function renderComments() {
    // WICHTIG: Nur gespeicherte Regions entfernen, NICHT die temp-Region des Users!
    // Dafür tracked savedRegionIds welche IDs wir selbst hinzugefügt haben.
    window.savedRegionIds.forEach(id => {
      const r = window.renderedRegions[id];
      if (r) { try { r.remove(); } catch {} }
    });
    window.savedRegionIds.clear();
    // renderedRegions nur die gespeicherten löschen, temp bleibt
    Object.keys(window.renderedRegions).forEach(id => {
      if (!id.startsWith('temp_')) delete window.renderedRegions[id];
    });

    const listDiv = document.getElementById("comments-list");

    // Filter nach aktueller Version
    // Kommentare ohne Zeitbezug (anchorType 'none') gelten fuer den ganzen
    // Song und bleiben deshalb ueber Versionsgrenzen hinweg sichtbar.
    let versionComments = allFolderComments.filter(
      c => !c.versionId || c.versionId === currentVersionId);

    // Regions zeichnen – KEINE id an addRegion übergeben!
    // WaveSurfer v7 überschreibt bei gleicher id eine vorhandene Region statt
    // eine neue zu erstellen → nur eine Region wurde sichtbar.
    // Fix: Region ohne id erstellen, id danach manuell setzen.
    versionComments.forEach(comment => {
      // Ohne Zeitbezug gibt es nichts zu zeichnen.
      if (comment.anchorType === 'none' || comment.deleted) return;
      const color = memberColor(comment.author);
      const region = wsRegions.addRegion({
        start: comment.start,
        // Pin-Kommentare haben keine Ausdehnung; WaveSurfer zeichnet sie dann
        // als Marker statt als Bereich.
        end: comment.anchorType === 'point' ? undefined : comment.end,
        color: color + "80",
        drag: false,
        resize: false,
        data: { saved: true, commentId: comment.id }
      });
      region.id = comment.id;
      window.renderedRegions[comment.id] = region;
      window.savedRegionIds.add(comment.id);
      region.on('over', () => window.highlightRegion(comment.id));
      region.on('leave', () => window.unhighlightRegion(comment.id));
    });

    // Sortierung (auf Kopie, original bleibt unverändert)
    let sorted = [...versionComments];
    if (sortMode === "date") {
      sorted.sort((a, b) => sortDir * (new Date(a.timestamp) - new Date(b.timestamp)));
    } else if (sortMode === "replies") {
      sorted.sort((a, b) => sortDir * ((a.replies?.length || 0) - (b.replies?.length || 0)));
    } else { // "time"
      sorted.sort((a, b) => sortDir * (a.start - b.start));
    }

    // Fuzzy-Filter
    if (searchQuery) {
      sorted = sorted.filter(commentMatchesSearch);
    }

    // HTML bauen
    if (sorted.length === 0) {
      listDiv.innerHTML = `<p class="no-comments">${searchQuery ? '🔍 Keine Treffer für "' + searchQuery + '"' : 'Noch keine Kommentare. Bereich markieren und tippen!'}</p>`;
      return;
    }

    listDiv.innerHTML = sorted.map(c => generateCommentHTML(c)).join('');
  }

  // --- SORT & SEARCH CONTROLS ---
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) {
        // Gleicher Button nochmal → Richtung umkehren
        sortDir = sortDir * -1;
        btn.dataset.dir = sortDir === 1 ? 'asc' : 'desc';
        const arrow = btn.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = sortDir === 1 ? ' ↑' : ' ↓';
      } else {
        // Anderen Button → auf diesen wechseln, Richtung zurücksetzen
        document.querySelectorAll('.sort-btn').forEach(b => {
          b.classList.remove('active');
          const a = b.querySelector('.sort-arrow');
          if (a) a.textContent = '';
        });
        btn.classList.add('active');
        sortMode = btn.dataset.sort;
        sortDir = 1;
        const arrow = btn.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = ' ↑';
      }
      renderComments();
    });
  });

  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderComments();
  });

  // --- SEEK TO REGION ---
  window.seekToRegion = function(id) {
    const r = window.renderedRegions[id];
    if (r) {
      wavesurfer.seekTo(r.start / wavesurfer.getDuration());
    }
  };

  // --- BEARBEITEN UND LOESCHEN ---
  window.editComment = async function(id) {
    const comment = findCommentById(allFolderComments, id);
    if (!comment) return;
    const newText = prompt("Kommentar bearbeiten:", comment.text);
    if (newText === null || newText.trim() === "") return;
    try {
      await api.updateComment(id, { text: newText.trim() });
    } catch (err) {
      alert("Bearbeiten fehlgeschlagen: " + err);
    }
    await reloadComments();
    renderComments();
  };

  window.removeComment = async function(id) {
    if (!confirm("Kommentar wirklich löschen?")) return;
    try {
      await api.deleteComment(id);
    } catch (err) {
      alert("Löschen fehlgeschlagen: " + err);
    }
    await reloadComments();
    renderComments();
  };

  // --- ANTWORTEN ---
  window.checkReplyEnter = async function(e, commentId) {
    if (e.key !== 'Enter') return;
    const input = document.getElementById(`reply-input-${commentId}`);
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    try {
      await api.createComment({
        id: api.ulid(),
        songId: currentSongId,
        parentId: commentId,
        anchorType: "none",
        text,
      });
    } catch (err) {
      alert("Antwort konnte nicht gespeichert werden: " + err);
    }
    await reloadComments();
    renderComments();
  };

  // --- REACTIONS ---
  window.toggleReaction = async function(commentId, emoji) {
    // Sucht jetzt rekursiv: frueher fand .find() nur die oberste Ebene, eine
    // Reaktion auf eine Antwort lief deshalb ins Leere.
    const comment = findCommentById(allFolderComments, commentId);
    if (!comment) return;
    const reacted = comment.reactions?.[emoji]?.includes(currentConfig.current_user);
    try {
      if (reacted) await api.removeReaction(commentId, emoji);
      else await api.addReaction(commentId, emoji);
    } catch (err) {
      console.error("Reaktion fehlgeschlagen:", err);
    }
    await reloadComments();
    renderComments();
  };

  // --- KOMMENTARE NACHLADEN ---
  // Frueher wurde bei jeder Aenderung die komplette comments.json
  // zurueckgeschrieben - kommentierten zwei Leute gleichzeitig, gewann der
  // Letzte. Jetzt geht jede Aenderung einzeln an die API.
  async function reloadComments() {
    if (!currentSongId) return;
    try {
      const data = await api.getComments(currentSongId);
      allFolderComments = api.toTree(data.comments);
    } catch (err) {
      console.error("Kommentare konnten nicht geladen werden:", err);
      allFolderComments = [];
    }
  }

  // --- LEERTASTE = PLAY/PAUSE ---
  document.addEventListener('keydown', (e) => {
    // Nicht auslösen wenn der User gerade tippt
    if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      wavesurfer.playPause();
    }
  });

  // --- SEITENLEISTE ---
  function renderSidebar() {
    folderList.innerHTML = "";
    if (songs.length === 0) {
      folderList.innerHTML =
        "<p style='color:#888;font-size:0.85em;'>Noch keine Songs. Leg eine MP3 in den pre_pro-Ordner.</p>";
      return;
    }

    songs.forEach(song => {
      const songDiv = document.createElement("div");
      songDiv.className = "song-folder";
      songDiv.innerHTML = `<span class="folder-icon">📁</span> ${song.name}`;

      const versionsDiv = document.createElement("div");
      versionsDiv.className = "song-versions";

      song.versions.forEach(version => {
        const versionDiv = document.createElement("div");
        versionDiv.className = "version-item";
        versionDiv.innerHTML = `<span class="track-icon">🎵</span> ${version.filename}`;
        versionDiv.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll('.version-item').forEach(v => v.classList.remove('active-track'));
          versionDiv.classList.add('active-track');
          loadVersion(song, version);
        });
        versionsDiv.appendChild(versionDiv);
      });

      songDiv.addEventListener("click", () => {
        const isHidden = versionsDiv.style.display === "" || versionsDiv.style.display === "none";
        versionsDiv.style.display = isHidden ? "block" : "none";
        songDiv.classList.toggle('open', isHidden);
      });

      folderList.appendChild(songDiv);
      songDiv.appendChild(versionsDiv);
    });
  }


  // --- EINRICHTUNG ---
  // Erscheint, solange kein Geraetetoken hinterlegt ist. Bewusst schlicht:
  // Phase 3 baut die Oberflaeche ohnehin um.
  function showSetup(settings, errorText) {
    document.getElementById("comment-ui").style.display = "none";
    document.getElementById("waveform").style.display = "none";
    document.getElementById("transport").style.display = "none";
    currentSongTitle.textContent = "";
    folderList.innerHTML = "<p style='color:#888;font-size:0.85em;'>Erst einrichten.</p>";

    outputDiv.innerHTML = `
      <div class="comment-input-wrap" style="max-width:640px">
        <h4>Einrichtung</h4>
        ${errorText ? `<p style="color:var(--red);font-size:.8rem;margin-bottom:10px">${errorText}</p>` : ''}
        <p style="color:var(--text-dim);font-size:.82rem;line-height:1.55;margin-bottom:12px">
          Das Gerätetoken holst du dir einmalig im Browser. Es wird lokal
          gespeichert und verlässt diesen Rechner nicht.
        </p>
        <label style="display:block;font-size:.72rem;color:var(--text-dim);margin-bottom:4px">API-Adresse</label>
        <input type="text" id="setup-url" class="reply-input" style="max-width:100%"
               placeholder="https://songou-api.<name>.workers.dev"
               value="${settings.apiBaseUrl || ''}">

        <div style="margin:12px 0 4px">
          <button class="transport-btn" id="setup-pair">Token holen</button>
        </div>
        <label style="display:block;font-size:.72rem;color:var(--text-dim);margin:10px 0 4px">Gerätetoken</label>
        <input type="text" id="setup-token" class="reply-input" style="max-width:100%"
               placeholder="${settings.hasToken ? 'hinterlegt — leer lassen zum Beibehalten' : 'hier einfügen'}">

        <label style="display:block;font-size:.72rem;color:var(--text-dim);margin:12px 0 4px">pre_pro-Ordner</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="setup-folder" class="reply-input" style="flex:1;max-width:100%"
                 value="${settings.preProPath || ''}" placeholder="noch nicht gewählt">
          <button class="transport-btn" id="setup-browse">Wählen…</button>
        </div>

        <div style="margin-top:16px">
          <button class="transport-btn" id="setup-save">Speichern</button>
          <span id="setup-status" style="margin-left:10px;font-size:.75rem;color:var(--text-dim)"></span>
        </div>
      </div>`;

    document.getElementById('setup-pair').addEventListener('click', () => {
      const base = document.getElementById('setup-url').value.trim();
      // Die Kopplungsseite liegt auf dem auth-Worker, nicht auf der API.
      const pairUrl = base.replace('songou-api', 'songou-auth') + '/pair';
      invoke('open_pair_page', { url: pairUrl }).catch((err) => alert(err));
    });

    document.getElementById('setup-browse').addEventListener('click', async () => {
      const picked = await invoke('pick_folder');
      if (picked) document.getElementById('setup-folder').value = picked;
    });

    document.getElementById('setup-save').addEventListener('click', async () => {
      const status = document.getElementById('setup-status');
      status.textContent = 'Speichere…';
      try {
        await invoke('save_settings', {
          apiBaseUrl: document.getElementById('setup-url').value.trim(),
          deviceToken: document.getElementById('setup-token').value.trim() || null,
          preProPath: document.getElementById('setup-folder').value.trim(),
        });
        document.getElementById("waveform").style.display = "";
        document.getElementById("transport").style.display = "";
        await startup();
      } catch (err) {
        status.textContent = 'Fehlgeschlagen: ' + err;
      }
    });
  }

  // Der Tray-Eintrag "Ordner wählen" schickt hierher.
  listen('choose-folder', async () => {
    const settings = await invoke('get_settings');
    showSetup(settings);
  });

  // --- START ---
  await startup();

  async function startup() {
    const settings = await invoke("get_settings");
    if (!settings.hasToken || !settings.apiBaseUrl) {
      showSetup(settings);
      return;
    }
    try {
      await loadBootstrap();
    } catch (err) {
      showSetup(settings, "Verbindung fehlgeschlagen: " + err);
      return;
    }
    renderHeader();
    renderSidebar();

    // Der Sync-Agent meldet neue Versionen - dann Bibliothek nachziehen.
    listen('feed-updated', async () => {
      try {
        await loadBootstrap();
        renderSidebar();
      } catch {}
    });
  }
});

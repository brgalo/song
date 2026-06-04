import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';
import RegionsPlugin from 'https://unpkg.com/wavesurfer.js@7/dist/plugins/regions.esm.js';

const invoke = window.__TAURI__.core.invoke;

window.addEventListener("DOMContentLoaded", async () => {
  const outputDiv = document.getElementById("app");
  const playButton = document.getElementById("play-btn");
  const currentSongTitle = document.getElementById("current-song-title");
  const folderList = document.getElementById("folder-list");

  let currentConfig = { band_name: "Unbekannte Band", current_user: "Gast", members: {} };
  let currentFolderPath = "";
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
  function generateCommentHTML(comment, depth = 0, rootId = null) {
    const color = memberColor(comment.author);
    const isRoot = depth === 0;
    const currentRootId = isRoot ? comment.id : rootId;
    const timeStr = formatTime(comment.timestamp);
    const reactionCounts = isRoot ? getReactionCounts(comment) : null;

    // Reactions HTML (nur auf Root-Kommentaren)
    let reactionsHTML = '';
    if (isRoot) {
      const pickerBtns = REACTIONS.map(emoji => {
        const count = reactionCounts[emoji];
        const active = hasUserReacted(comment, emoji);
        return `<button class="reaction-btn ${active ? 'reacted' : ''}" 
          onclick="toggleReaction('${comment.id}', '${emoji}')" 
          title="${emoji}">
          ${emoji}${count > 0 ? `<span class="reaction-count">${count}</span>` : ''}
        </button>`;
      }).join('');
      reactionsHTML = `<div class="reactions-row">${pickerBtns}</div>`;
    }

    let html = `
      <div id="comment-box-${comment.id}" 
           class="${isRoot ? 'comment-box' : 'reply-box'}" 
           style="border-left: ${isRoot ? '4px' : '2px'} solid ${color};"
           onmouseenter="highlightRegion('${currentRootId}')"
           onmouseleave="unhighlightRegion('${currentRootId}')">
        <div style="position: relative;">
          ${isRoot ? `<div class="comment-actions">
            <button class="icon-btn" onclick="seekToRegion('${comment.id}')" title="Zur Stelle springen">⏮</button>
            <button class="icon-btn" onclick="editComment('${comment.id}')" title="Bearbeiten">✏️</button>
          </div>` : ''}
          <strong style="color: ${color}">${comment.author}</strong>
          ${isRoot ? `<span class="time-badge">${formatSeconds(comment.start)} – ${formatSeconds(comment.end)}</span>` : ''}
          <span class="timestamp-label">${timeStr}</span>
          <div class="comment-text">${comment.text}</div>
        </div>
        ${reactionsHTML}
        ${(comment.replies?.length > 0) ? comment.replies.map(r => generateCommentHTML(r, depth + 1, currentRootId)).join('') : ''}
        <div class="reply-row">
          <input type="text" id="reply-input-${comment.id}" 
                 placeholder="Antworten… (Enter)"
                 class="reply-input"
                 onkeydown="checkReplyEnter(event, '${comment.id}')">
        </div>
      </div>`;
    return html;
  }

  // --- CONFIG + LOKALER USER ---
  try {
    const configString = await invoke("read_config");
    currentConfig = { ...currentConfig, ...JSON.parse(configString) };
  } catch {
    // config.json fehlt – Gast-Modus, members bleibt leer
  }

  // Lokal gespeicherten Usernamen laden (überschreibt config.current_user)
  try {
    const localUser = await invoke("read_local_user");
    if (localUser && localUser.trim()) {
      currentConfig.current_user = localUser.trim();
    }
  } catch {}

  // Header rendern (mit klickbarem Namen)
  function renderHeader() {
    // members kann Objekt {Name: Farbe} oder Array sein – beides abfangen
    const rawMembers = currentConfig.members || {};
    const members = Array.isArray(rawMembers)
      ? rawMembers  // altes Format: string-array
      : Object.keys(rawMembers);  // neues Format: {name: color}

    const memberOptions = members.length > 0
      ? members.map(m => `<option value="${m}" ${m === currentConfig.current_user ? 'selected' : ''}>${m}</option>`).join('')
      : `<option value="${currentConfig.current_user}">${currentConfig.current_user}</option>`;

    outputDiv.innerHTML = `
      <div class="band-header">
        <h2 class="band-title">${currentConfig.band_name}</h2>
        <div class="user-select-wrap">
          <span class="user-prefix">● Du bist:</span>
          <select id="user-select" class="user-select">
            ${memberOptions}
            <option value="__custom__">Anderer Name…</option>
          </select>
        </div>
      </div>`;

    document.getElementById('user-select').addEventListener('change', async (e) => {
      if (e.target.value === '__custom__') {
        const name = prompt('Dein Name:', currentConfig.current_user);
        if (name && name.trim()) {
          currentConfig.current_user = name.trim();
        }
        // Dropdown neu rendern damit "__custom__" nicht selected bleibt
        renderHeader();
        return; // save passiert rekursiv nach renderHeader via neuem Listener
      }
      // Name direkt setzen und sofort speichern
      currentConfig.current_user = e.target.value;
      try {
        await invoke("save_local_user", { username: currentConfig.current_user });
        console.log("User gespeichert:", currentConfig.current_user);
      } catch(err) {
        console.error("Fehler beim Speichern des Users:", err);
      }
    });
  }
  renderHeader();
  // Nach renderHeader den gespeicherten User einmalig speichern damit er beim
  // nächsten Start gleich vorausgewählt ist
  invoke("save_local_user", { username: currentConfig.current_user }).catch(() => {});

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

    const commentId = Date.now().toString();
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

    allFolderComments.push(newComment);
    activeRegion = null;
    input.value = "";

    await saveToServer();
    renderComments();
  });

  // --- AUDIO LADEN ---
  async function loadAudioFromDisk(filePath, versionName) {
    try {
      // Loading-State: Titel + Waveform-Overlay + Kommentare ausblenden
      currentSongTitle.textContent = "⏳ Lade: " + versionName + "…";
      document.getElementById('waveform').classList.add('loading');
      document.getElementById('comments-list').innerHTML =
        '<p class="no-comments loading-pulse">Lade Kommentare…</p>';

      const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      currentFolderPath = filePath.substring(0, lastSlash);
      currentVersionName = versionName;

      const audioBytes = await invoke("load_audio_file", { path: filePath });
      const ext = filePath.split('.').pop().toLowerCase();
      const mimeType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const blob = new Blob([new Uint8Array(audioBytes)], { type: mimeType });

      wsRegions.clearRegions();
      window.renderedRegions = {};
      window.savedRegionIds.clear();
      activeRegion = null;
      activeLoopRegion = null;
      isLooping = false;
      updateLoopIndicator();
      document.getElementById("comment-ui").style.display = "block";

      wavesurfer.load(URL.createObjectURL(blob));

      // Kommentare laden während WaveSurfer noch dekodiert
      try {
        const commentsJson = await invoke("read_comments", { folderPath: currentFolderPath });
        allFolderComments = JSON.parse(commentsJson);
      } catch (err) {
        console.error("Fehler beim Laden der Kommentare:", err);
        allFolderComments = [];
      }

      wavesurfer.once('ready', () => {
        currentSongTitle.textContent = "▶ " + versionName;
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
    let versionComments = allFolderComments.filter(c => c.version === currentVersionName);

    // Regions zeichnen – KEINE id an addRegion übergeben!
    // WaveSurfer v7 überschreibt bei gleicher id eine vorhandene Region statt
    // eine neue zu erstellen → nur eine Region wurde sichtbar.
    // Fix: Region ohne id erstellen, id danach manuell setzen.
    versionComments.forEach(comment => {
      const color = memberColor(comment.author);
      const region = wsRegions.addRegion({
        start: comment.start,
        end: comment.end,
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

  // --- EDIT ---
  window.editComment = async function(id) {
    const comment = allFolderComments.find(c => c.id === id);
    if (!comment) return;
    const newText = prompt("Kommentar bearbeiten:", comment.text);
    if (newText !== null && newText.trim() !== "") {
      comment.text = newText.trim();
      await saveToServer();
      renderComments();
    }
  };

  // --- ANTWORTEN ---
  window.checkReplyEnter = async function(e, commentId) {
    if (e.key !== 'Enter') return;
    const input = document.getElementById(`reply-input-${commentId}`);
    const text = input.value.trim();
    if (!text) return;

    const target = findCommentById(allFolderComments, commentId);
    if (target) {
      if (!target.replies) target.replies = [];
      target.replies.push({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
        author: currentConfig.current_user,
        text,
        timestamp: new Date().toISOString(),
        replies: []
      });
      await saveToServer();
      renderComments();
    }
  };

  // --- REACTIONS ---
  window.toggleReaction = async function(commentId, emoji) {
    const comment = allFolderComments.find(c => c.id === commentId);
    if (!comment) return;
    if (!comment.reactions) comment.reactions = {};
    if (!comment.reactions[emoji]) comment.reactions[emoji] = [];

    const userIndex = comment.reactions[emoji].indexOf(currentConfig.current_user);
    if (userIndex === -1) {
      comment.reactions[emoji].push(currentConfig.current_user);
    } else {
      comment.reactions[emoji].splice(userIndex, 1);
    }

    await saveToServer();
    renderComments();
  };

  // --- SPEICHERN ---
  async function saveToServer() {
    try {
      await invoke("save_comments", {
        folderPath: currentFolderPath,
        commentsJson: JSON.stringify(allFolderComments, null, 2)
      });
    } catch (err) {
      console.error("Fehler beim Speichern:", err);
      alert("Fehler beim Speichern auf der Festplatte!");
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

  // --- ORDNER SCANNEN ---
  try {
    const songs = await invoke("scan_directory");
    folderList.innerHTML = "";

    if (songs.length === 0) {
      folderList.innerHTML = "<p style='color:#888;font-size:0.85em;'>Keine Audio-Dateien gefunden.</p>";
    }

    songs.forEach(songFolder => {
      const songDiv = document.createElement("div");
      songDiv.className = "song-folder";
      songDiv.innerHTML = `<span class="folder-icon">📁</span> ${songFolder.name}`;

      const versionsDiv = document.createElement("div");
      versionsDiv.className = "song-versions";

      songFolder.versions.forEach(version => {
        const versionDiv = document.createElement("div");
        versionDiv.className = "version-item";
        versionDiv.innerHTML = `<span class="track-icon">🎵</span> ${version.name}`;
        versionDiv.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll('.version-item').forEach(v => v.classList.remove('active-track'));
          versionDiv.classList.add('active-track');
          loadAudioFromDisk(version.path, version.name);
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
  } catch (error) {
    folderList.innerHTML = `<p style="color: #f87171;">Fehler beim Scannen: ${error}</p>`;
  }
});

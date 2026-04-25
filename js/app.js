const isOverlay = window.location.hash === '#overlay';
const isMessagesOverlay = window.location.hash === '#messages';
const isAnyOverlay = isOverlay || isMessagesOverlay;
document.body.className = isOverlay
  ? 'overlay-mode'
  : isMessagesOverlay
    ? 'messages-mode'
    : 'controller-mode';

const STORAGE_KEY = 'obs-routines-state-v2';
const OLD_STORAGE_KEY = 'obs-routines-state-v1';
const API_URL = '/api/state';

// Where to fetch the update manifest. Leave empty to disable update checks.
// Expected JSON shape:
//   { "version": "1.1.0",
//     "downloadUrl": "https://.../Routine-Tracker-1.1.0-arm64.dmg",
//     "downloadUrlX64": "https://.../Routine-Tracker-1.1.0-x64.dmg",
//     "releaseNotes": "Fixed X, added Y" }
const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/conquerdesigngroup/routine-tracker/main/update-manifest.json';
const AUTO_CHECK_KEY = 'auto-check-updates';
const LAST_CHECK_KEY  = 'update-last-check';

let currentVersion = '';
let updateInfo = null;

// state.current = null OR { number, title, fromIndex: number|null, isDropIn: bool }
// state.hidden = true means overlay is blanked but the current position is kept
// Catalog of overlay fonts. Keep keys in sync with the @font-face declarations
// in styles.css and the <option> values in index.html.
const OVERLAY_FONTS = {
  'Avega':                'Avega, Poppins, sans-serif',
  'Franie Black Italic':  '"Franie Black Italic", Poppins, sans-serif',
  'Know':                 'Know, Poppins, sans-serif',
  'Railway Gank':         '"Railway Gank", Poppins, sans-serif'
};
const DEFAULT_OVERLAY_FONT = 'Avega';

function normalizeOverlayFont(name) {
  return (name && OVERLAY_FONTS[name]) ? name : DEFAULT_OVERLAY_FONT;
}

function applyRoutineFont(name) {
  const stack = OVERLAY_FONTS[normalizeOverlayFont(name)];
  document.documentElement.style.setProperty('--routine-font', stack);
}

function applyMessageFont(name) {
  const stack = OVERLAY_FONTS[normalizeOverlayFont(name)];
  document.documentElement.style.setProperty('--message-font', stack);
}

function applyAllFonts() {
  applyRoutineFont(state.routineFont);
  applyMessageFont(state.messageFont);
}

// Catalog of overlay text-style options. Stored in state so the choice syncs
// across the controller + both OBS browser sources.
const OVERLAY_TEXT_STYLES = ['shadow', 'outline', 'none'];
const DEFAULT_OVERLAY_TEXT_STYLE = 'shadow';

function normalizeOverlayTextStyle(name) {
  return OVERLAY_TEXT_STYLES.includes(name) ? name : DEFAULT_OVERLAY_TEXT_STYLE;
}

function applyOverlayTextStyle(name) {
  document.documentElement.dataset.overlayStyle = normalizeOverlayTextStyle(name);
}

let state = {
  routines: [],
  current: null,
  hidden: false,
  clearedBackup: null,
  message: { text: '', visible: false },
  routineFont: DEFAULT_OVERLAY_FONT,
  messageFont: DEFAULT_OVERLAY_FONT,
  overlayTextStyle: DEFAULT_OVERLAY_TEXT_STYLE
};
let serverMode = false;   // true = sync via server API (Electron); false = localStorage only
let lastServerJSON = '';  // last JSON we've seen from server, for change detection
let lastPollOk = 0;       // timestamp of last successful server poll (for conn status)
const POLL_STALE_MS = 5000; // poll older than this → conn-status flips to "error"

async function detectServerMode() {
  try {
    const resp = await fetch(API_URL, { method: 'GET', cache: 'no-store' });
    if (resp.ok) {
      serverMode = true;
      lastPollOk = Date.now();
      const data = await resp.json();
      applyRemoteState(data);
      // Recovery: if the server lost its state but localStorage still has
      // routines (e.g. migrating from the file:// version, or state.json was
      // reset), restore from local and push back to the server.
      if (!data.routines || data.routines.length === 0) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.routines) && parsed.routines.length > 0) {
              const legacy = parsed.overlayFont;
              state = {
                routines: parsed.routines,
                current: parsed.current ?? null,
                hidden: !!parsed.hidden,
                clearedBackup: parsed.clearedBackup || null,
                message: normalizeMessage(parsed.message),
                routineFont: normalizeOverlayFont(parsed.routineFont ?? legacy),
                messageFont: normalizeOverlayFont(parsed.messageFont ?? legacy),
                overlayTextStyle: normalizeOverlayTextStyle(parsed.overlayTextStyle)
              };
              saveState();
            }
          }
        } catch (_) {}
      }
      return;
    }
  } catch (_) {}
  serverMode = false;
  loadLocalState();
}

function applyRemoteState(data) {
  const legacy = data.overlayFont;
  state = {
    routines: Array.isArray(data.routines) ? data.routines : [],
    current: data.current ?? null,
    hidden: !!data.hidden,
    clearedBackup: data.clearedBackup || null,
    message: normalizeMessage(data.message),
    routineFont: normalizeOverlayFont(data.routineFont ?? legacy),
    messageFont: normalizeOverlayFont(data.messageFont ?? legacy),
    overlayTextStyle: normalizeOverlayTextStyle(data.overlayTextStyle)
  };
  lastServerJSON = JSON.stringify(state);
  applyAllFonts();
  applyOverlayTextStyle(state.overlayTextStyle);
}

function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return { text: '', visible: false };
  return { text: typeof m.text === 'string' ? m.text : '', visible: !!m.visible };
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const legacy = parsed.overlayFont;
      state = {
        routines: Array.isArray(parsed.routines) ? parsed.routines : [],
        current: parsed.current ?? null,
        hidden: !!parsed.hidden,
        clearedBackup: parsed.clearedBackup || null,
        message: normalizeMessage(parsed.message),
        routineFont: normalizeOverlayFont(parsed.routineFont ?? legacy),
        messageFont: normalizeOverlayFont(parsed.messageFont ?? legacy),
        overlayTextStyle: normalizeOverlayTextStyle(parsed.overlayTextStyle)
      };
      applyAllFonts();
      applyOverlayTextStyle(state.overlayTextStyle);
      return;
    }
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (old) {
      const parsed = JSON.parse(old);
      state.routines = parsed.routines || [];
      if (parsed.currentIndex >= 0 && state.routines[parsed.currentIndex]) {
        const r = state.routines[parsed.currentIndex];
        state.current = { number: r.number, title: r.title, fromIndex: parsed.currentIndex, isDropIn: false };
      }
    }
  } catch (_) {}
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  if (serverMode) {
    lastServerJSON = JSON.stringify(state);
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: lastServerJSON
    }).catch(() => {});
  }
}

// ========= UPDATES =========
async function loadCurrentVersion() {
  if (!serverMode) return;
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      currentVersion = j.version || '';
    }
  } catch (_) {}
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function isAutoCheckEnabled() {
  const v = localStorage.getItem(AUTO_CHECK_KEY);
  return v === null ? true : v === 'true';
}
function setAutoCheckEnabled(on) {
  localStorage.setItem(AUTO_CHECK_KEY, String(!!on));
}

async function checkForUpdates(manual) {
  if (!UPDATE_MANIFEST_URL) {
    if (manual) alert('Update URL is not configured yet.\n\nEdit UPDATE_MANIFEST_URL in js/app.js to point at your hosted update-manifest.json.');
    return;
  }
  const btn = document.getElementById('update-check-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const r = await fetch(UPDATE_MANIFEST_URL + (UPDATE_MANIFEST_URL.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();
    if (!m.version) throw new Error('Manifest missing "version" field');
    localStorage.setItem(LAST_CHECK_KEY, new Date().toISOString());
    if (currentVersion && compareVersions(m.version, currentVersion) > 0) {
      updateInfo = m;
    } else {
      updateInfo = null;
      if (manual) alert(`You're already on the latest version (v${currentVersion || '?'}).`);
    }
    renderUpdateBanner();
    renderFooter();
  } catch (e) {
    if (manual) alert('Could not check for updates.\n\n' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
  }
}

function pickDownloadUrl() {
  if (!updateInfo) return '';
  // Prefer arm64 on Apple Silicon, x64 otherwise. Platform hint via userAgent.
  const isArm = /arm64|aarch64/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.userAgent.includes('Mac'));
  // userAgent on Apple Silicon reports MacIntel for back-compat, so this isn't perfectly reliable —
  // if the manifest only has one URL, fall back to it.
  if (isArm && updateInfo.downloadUrl) return updateInfo.downloadUrl;
  return updateInfo.downloadUrlX64 || updateInfo.downloadUrl || '';
}

function renderUpdateBanner() {
  const el = document.getElementById('update-banner');
  if (!el) return;
  if (!updateInfo) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.querySelector('.up-version').textContent = 'v' + updateInfo.version;
  const notesEl = el.querySelector('.up-notes');
  if (notesEl) notesEl.textContent = updateInfo.releaseNotes || '';
  const dl = el.querySelector('.up-download');
  if (dl) dl.onclick = () => {
    const url = pickDownloadUrl();
    if (url) window.open(url, '_blank');
  };
}

function renderFooter() {
  const v = document.getElementById('app-version');
  if (v) v.textContent = currentVersion || 'dev';
  const toggle = document.getElementById('auto-check-toggle');
  if (toggle) toggle.checked = isAutoCheckEnabled();
  const last = document.getElementById('last-check-label');
  if (last) {
    const iso = localStorage.getItem(LAST_CHECK_KEY);
    last.textContent = iso ? 'Last checked ' + new Date(iso).toLocaleString() : '';
  }
}

async function pollServerState() {
  if (!serverMode) return;
  try {
    const resp = await fetch(API_URL, { method: 'GET', cache: 'no-store' });
    if (!resp.ok) return;
    const txt = await resp.text();
    lastPollOk = Date.now();
    if (txt === lastServerJSON) return;
    lastServerJSON = txt;
    applyRemoteState(JSON.parse(txt));
    applyAllFonts();
    applyOverlayTextStyle(state.overlayTextStyle);
    render();
  } catch (_) {}
}

async function parsePDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Group items into lines by Y coordinate
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x, str: item.str });
    }
    // Sort rows top→bottom (higher y = higher on page)
    const sortedY = [...rows.keys()].sort((a, b) => b - a);
    for (const y of sortedY) {
      const row = rows.get(y).sort((a, b) => a.x - b.x);
      lines.push(row.map(r => r.str).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  return extractRoutinesFromLines(lines);
}

function cleanTitle(raw) {
  let t = raw.trim();
  // Strip common dance age-group + level suffix (e.g. "Junior Starter", "Teen Competitive")
  const ageRx = /\s+(Petite|Mini|Junior|Teen|Senior|Adult|Pre-?Teen|Pre-?Competitive)\s+(Starter|Beginner|Intermediate|Advanced|Competitive|Elite|Recreational|Performance|Showcase)\s*$/i;
  t = t.replace(ageRx, '').trim();
  // Strip trailing style suffix (e.g. "Jazz Solo", "Tap Duo/Trio", "Jazz Small Groups")
  const styleRx = /\s+(Jazz|Tap|Ballet|Lyrical|Modern|Lyrical\/Modern|Contemporary|Hip Hop|Hip-Hop|Open|Musical Theater|Acro|Pointe|Clogging|Song and Dance|Production)\s+(Solo|Duet|Duo|Trio|Duo\/Trio|Duet\/Trio|Small Groups?|Large Groups?|Line|Extended Line|Production)\s*$/i;
  t = t.replace(styleRx, '').trim();
  return t;
}

// Titles that look truncated (end with a preposition/article/conjunction) likely wrapped
// to the next PDF line.
const TITLE_LOOKS_WRAPPED = /\b(a|an|the|in|on|at|of|to|for|by|from|with|about|over|under|through|and|or|but|as|like|into|onto|your|my|this|that|these|those|against|without)$/i;

// Dance styles — used to detect where the "style line" is within the next few rows.
const STYLE_KW_RX = /(Jazz|Tap|Ballet|Lyrical(?:\/Modern)?|Modern|Contemporary|Hip[-\s]?Hop|Open|Musical Theater|Acro|Pointe|Clogging|Song and Dance|Production)\b/i;

// Given the rows that follow a wrapped routine line, locate the style line and
// return any non-style prefix on that line (the real title continuation).
// Example: "Heavens Lyrical/Modern Small" → "Heavens"
//          "Jazz Small Groups"            → ''
function extractTitleContinuation(followingLines) {
  for (const line of followingLines) {
    if (!line) continue;
    // If a dancer list (has a comma) shows up before a style line, bail.
    if (line.includes(',')) return '';
    // Line starts with a style keyword → no continuation, this is just the style line.
    if (new RegExp('^\\s*' + STYLE_KW_RX.source, 'i').test(line)) return '';
    // Line has a style keyword mid-line — the prefix is the continuation.
    const m = line.match(new RegExp('^(.+?)\\s+' + STYLE_KW_RX.source, 'i'));
    if (m) return m[1].trim();
  }
  return '';
}

function extractRoutinesFromLines(lines) {
  const routines = [];
  let lastNum = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\d{1,4})\s+(.{2,}?)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    // Accept any strictly increasing number — handles skipped numbers (e.g. 181 → 183)
    // while rejecting re-scans of already-seen routines
    if (num <= lastNum) continue;
    let title = cleanTitle(m[2]);
    if (!title) continue;
    if (/^(name|age|show order|letter|group|style)/i.test(title)) continue;

    // Stitch wrapped titles by scanning the next few rows for the style line
    if (TITLE_LOOKS_WRAPPED.test(title)) {
      const cont = extractTitleContinuation(lines.slice(i + 1, i + 7));
      if (cont) title = (title + ' ' + cont).trim();
    }

    routines.push({ number: String(num), title });
    lastNum = num;
  }
  return routines;
}

function parseInput(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const match = line.match(/^(\S+?)\s*[.,\-\t:)\]]\s*(.+)$/) || line.match(/^(\S+)\s+(.+)$/);
    if (match) parsed.push({ number: match[1].trim(), title: match[2].trim() });
    else parsed.push({ number: line, title: '' });
  }
  return parsed;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function findRoutineIndex(number) {
  return state.routines.findIndex(r => String(r.number) === String(number));
}

function insertRoutineSorted(routine) {
  const num = parseFloat(routine.number);
  if (isNaN(num)) {
    state.routines.push(routine);
    return state.routines.length - 1;
  }
  for (let i = 0; i < state.routines.length; i++) {
    const existingNum = parseFloat(state.routines[i].number);
    if (!isNaN(existingNum) && num < existingNum) {
      state.routines.splice(i, 0, routine);
      return i;
    }
  }
  state.routines.push(routine);
  return state.routines.length - 1;
}

function setCurrentFromIndex(i) {
  if (i < 0 || i >= state.routines.length) { state.current = null; return; }
  const r = state.routines[i];
  r.shown = true;
  const keepStart = state.current && state.current.fromIndex === i && state.current.startedAt
    ? state.current.startedAt
    : Date.now();
  state.current = { number: r.number, title: r.title, fromIndex: i, isDropIn: false, startedAt: keepStart };
  state.hidden = false;
}

function setCurrentFromNumber(number) {
  const idx = findRoutineIndex(number);
  if (idx >= 0) setCurrentFromIndex(idx);
  else state.current = { number: number, title: '', fromIndex: null, isDropIn: false, startedAt: Date.now() };
  state.hidden = false;
}

function setCurrentDropIn(number, title) {
  state.current = { number, title: title || '', fromIndex: null, isDropIn: true, startedAt: Date.now() };
  state.hidden = false;
}

// ========= RENDERING =========
// Compute the exact text the routine OBS overlay would show for the current
// state. Returns '' when the overlay would be blank (hidden / no current).
function currentOverlayText() {
  if (state.hidden || !state.current || !state.current.number) return '';
  const title = state.current.title || '';
  return title ? `${state.current.number} - ${title}` : state.current.number;
}

function renderOverlay() {
  const el = document.getElementById('ov-text');
  if (!el) return;
  const text = currentOverlayText();
  if (!text) {
    el.textContent = '';
    el.style.visibility = 'hidden';
    return;
  }
  el.style.visibility = 'visible';
  el.textContent = text;
}

function renderOverlayPreview() {
  const strip = document.getElementById('overlay-preview-strip');
  const text = document.getElementById('ov-preview-text');
  if (!strip || !text) return;
  const t = currentOverlayText();
  text.textContent = t;
  strip.classList.toggle('is-empty', !t);
}

function renderController() {
  const csNumber = document.getElementById('cs-number');
  const csTitle = document.getElementById('cs-title');
  const list = document.getElementById('routine-list');
  document.getElementById('count').textContent = state.routines.length;

  if (!state.current || !state.current.number) {
    csNumber.textContent = '—';
    csTitle.textContent = 'Nothing showing';
  } else {
    csNumber.textContent = state.current.number;
    const titleText = state.current.title || '(no title)';
    const hiddenBadge = state.hidden ? ' <span class="badge badge-hidden">Hidden</span>' : '';
    const kindBadge = state.current.isDropIn ? ' <span class="badge">Drop-in</span>' :
                  (state.current.fromIndex === null ? ' <span class="badge">Manual</span>' : '');
    csTitle.innerHTML = escapeHTML(titleText) + hiddenBadge + kindBadge;
  }

  const hideBtn = document.getElementById('clear-btn');
  if (hideBtn) {
    hideBtn.textContent = state.hidden ? 'Show Overlay' : 'Hide Overlay';
    hideBtn.classList.toggle('hidden-active', !!state.hidden);
  }

  renderOverlayPreview();
  updateElapsedTimer();

  // Next Up: shown only when the current routine came from the list and has a successor
  const nextUp = document.getElementById('next-up');
  if (nextUp) {
    const idx = state.current ? state.current.fromIndex : null;
    const next = idx !== null && idx >= 0 && idx < state.routines.length - 1
      ? state.routines[idx + 1]
      : null;
    if (next) {
      nextUp.style.display = 'flex';
      document.getElementById('nu-number').textContent = next.number;
      document.getElementById('nu-title').textContent = next.title || '(no title)';
    } else {
      nextUp.style.display = 'none';
    }
  }

  // Reset Progress button only appears once at least one routine is marked shown
  const resetBtn = document.getElementById('reset-progress-btn');
  if (resetBtn) {
    const anyShown = state.routines.some(r => r.shown);
    resetBtn.style.display = anyShown ? '' : 'none';
  }

  // Recover Cleared: shown only when a backup exists from a prior Clear All
  const recoverBtn = document.getElementById('recover-btn');
  if (recoverBtn) {
    const b = state.clearedBackup;
    if (b && Array.isArray(b.routines) && b.routines.length > 0) {
      recoverBtn.style.display = '';
      const when = b.at ? new Date(b.at).toLocaleString() : '';
      recoverBtn.title = `Restore ${b.routines.length} routine${b.routines.length === 1 ? '' : 's'} cleared${when ? ' at ' + when : ''}`;
    } else {
      recoverBtn.style.display = 'none';
    }
  }

  const activeIdx = state.current ? state.current.fromIndex : null;

  const filterRow = document.getElementById('routine-filter-row');
  if (filterRow) filterRow.style.display = state.routines.length > 0 ? 'flex' : 'none';

  if (state.routines.length === 0) {
    list.innerHTML = '<div class="empty">No routines loaded yet.<br>Paste your list on the right →</div>';
  } else {
    const q = routineFilter.trim().toLowerCase();
    const visible = state.routines
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => {
        if (hideShown && r.shown && i !== activeIdx) return false;
        if (!q) return true;
        return String(r.number).toLowerCase().includes(q) || String(r.title).toLowerCase().includes(q);
      });

    if (visible.length === 0) {
      const emptyMsg = q
        ? `No routines match "${escapeHTML(routineFilter)}".`
        : 'All routines marked shown. Toggle off "Hide Shown" to see them.';
      list.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      updateKeypadMatch();
      return;
    }

    const previewIdx = keypadValue ? state.routines.findIndex(r => String(r.number).toLowerCase().startsWith(keypadValue.toLowerCase())) : -1;

    list.innerHTML = visible.map(({ r, i }) => `
      <div class="routine-item ${i === activeIdx ? 'active' : ''} ${r.shown ? 'shown' : ''} ${i === previewIdx ? 'preview' : ''}" data-idx="${i}">
        <div class="r-num">${escapeHTML(r.number)}</div>
        <div class="r-title">${escapeHTML(r.title)}${r.addedLive ? '<span class="tag-dropin">added</span>' : ''}</div>
        <button class="r-del" data-del="${i}" title="Remove">✕</button>
      </div>
    `).join('');

    list.querySelectorAll('.routine-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('r-del')) return;
        setCurrentFromIndex(parseInt(el.dataset.idx));
        saveState();
        render();
      });
    });
    list.querySelectorAll('.r-del').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(el.dataset.del);
        const removed = state.routines[i];
        // Snapshot just enough to put the routine back exactly where it was,
        // including the current pointer's relationship to it.
        const prevCurrent = state.current ? { ...state.current } : null;
        state.routines.splice(i, 1);
        if (state.current && state.current.fromIndex === i) state.current = null;
        else if (state.current && state.current.fromIndex > i) state.current.fromIndex--;
        saveState();
        render();
        if (removed) {
          const label = removed.title ? `"${removed.title}"` : `#${removed.number}`;
          showUndoToast(`Removed ${label}`, () => {
            state.routines.splice(i, 0, removed);
            state.current = prevCurrent;
            saveState();
            render();
          });
        }
      });
    });

    const scrollTarget = list.querySelector('.routine-item.preview') || list.querySelector('.routine-item.active');
    if (scrollTarget) {
      const listRect = list.getBoundingClientRect();
      const itemRect = scrollTarget.getBoundingClientRect();
      if (itemRect.top < listRect.top) {
        list.scrollTop += itemRect.top - listRect.top - 8;
      } else if (itemRect.bottom > listRect.bottom) {
        list.scrollTop += itemRect.bottom - listRect.bottom + 8;
      }
    }
  }

  updateKeypadMatch();
}

function render() {
  if (isOverlay) renderOverlay();
  else if (isMessagesOverlay) renderMessagesOverlay();
  else renderController();
}

// Build a seamless news-ticker inside `track`. Duplicates the text enough times
// that one copy is always entering as another exits, then animates a translateX
// of exactly one item-width. When the keyframes loop, the next copy is already
// in position — no visible gap.
function buildTicker(track, text, options) {
  if (!track) return;
  const opts = options || {};
  const speed = opts.speed || 150;            // px/sec
  const trimmed = (text || '').trim();

  if (!trimmed) {
    track.innerHTML = '';
    track.classList.remove('scrolling');
    delete track.dataset.text;
    return;
  }

  // Build first copy and measure it
  track.classList.remove('scrolling');
  track.innerHTML = '';
  const first = document.createElement('span');
  first.className = 'ticker-item';
  first.textContent = trimmed;
  track.appendChild(first);
  void track.offsetWidth;
  const itemWidth = first.offsetWidth;
  if (itemWidth <= 0) return;

  // Duplicate enough times that the visible viewport is covered + buffer
  const viewportWidth =
    opts.viewportWidth ||
    (track.parentElement ? track.parentElement.offsetWidth : 0) ||
    window.innerWidth;
  const copies = Math.max(2, Math.ceil((viewportWidth + itemWidth) / itemWidth) + 1);
  for (let i = 1; i < copies; i++) {
    const c = first.cloneNode(true);
    c.setAttribute('aria-hidden', 'true');
    track.appendChild(c);
  }

  const duration = Math.max(2, itemWidth / speed);
  track.style.setProperty('--ticker-duration', duration + 's');
  track.style.setProperty('--ticker-shift', '-' + itemWidth + 'px');
  track.dataset.text = trimmed;

  // Restart animation
  void track.offsetWidth;
  track.classList.add('scrolling');
}

function renderMessagesOverlay() {
  const track = document.getElementById('msg-ticker');
  if (!track) return;
  const msg = state.message || { text: '', visible: false };
  const shouldShow = msg.visible && msg.text && msg.text.trim().length > 0;

  if (!shouldShow) {
    track.innerHTML = '';
    track.classList.remove('scrolling');
    delete track.dataset.text;
    track.style.visibility = 'hidden';
    return;
  }

  track.style.visibility = 'visible';
  // Only rebuild when the text actually changes, so in-flight scrolls aren't
  // restarted on unrelated state polls.
  if (track.dataset.text !== msg.text.trim()) {
    buildTicker(track, msg.text, { viewportWidth: window.innerWidth });
  } else if (!track.classList.contains('scrolling')) {
    track.classList.add('scrolling');
  }
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function updateElapsedTimer() {
  const t = document.getElementById('cs-timer');
  if (!t) return;
  if (!state.current || !state.current.startedAt) {
    t.textContent = '';
    t.classList.remove('timer-dim');
    return;
  }
  t.textContent = '⏱ ' + formatElapsed(Date.now() - state.current.startedAt);
  t.classList.toggle('timer-dim', !!state.hidden);
}

// ========= KEYPAD =========
let keypadValue = '';
let routineFilter = '';
const HIDE_SHOWN_KEY = 'rt-hide-shown-v1';
let hideShown = localStorage.getItem(HIDE_SHOWN_KEY) === 'true';
const SHOW_MODE_KEY = 'rt-show-mode-v1';
let showMode = localStorage.getItem(SHOW_MODE_KEY) === 'true';

function applyShowMode() {
  document.body.classList.toggle('show-mode', showMode);
  const btn = document.getElementById('mode-toggle');
  if (btn) {
    btn.textContent = showMode ? '⚙ Exit Show Mode' : '🎬 Enter Show Mode';
    btn.classList.toggle('show-mode-active', showMode);
  }
}

// ========= CONNECTION STATUS =========
// Reflects whether the controller is talking to the Electron server, running
// in localStorage-only mode, or has lost touch with a server it was using.
function updateConnStatus() {
  const el = document.getElementById('conn-status');
  if (!el) return;
  let s, label;
  if (!serverMode) {
    s = 'local';
    label = 'Local only';
  } else if (Date.now() - lastPollOk > POLL_STALE_MS) {
    s = 'error';
    label = 'Server unreachable';
  } else {
    s = 'ok';
    label = 'Connected';
  }
  if (el.dataset.state !== s) el.dataset.state = s;
  const lbl = el.querySelector('.conn-label');
  if (lbl && lbl.textContent !== label) lbl.textContent = label;
}

// ========= UNDO TOAST =========
// Lightweight toast pill at the bottom of the screen. Single-slot — a new
// toast replaces any in-flight one so the user always sees the latest action.
let undoTimer = null;
function showUndoToast(message, onUndo, durationMs) {
  const toast = document.getElementById('undo-toast');
  const text = document.getElementById('undo-toast-text');
  const btn = document.getElementById('undo-toast-btn');
  const close = document.getElementById('undo-toast-close');
  if (!toast || !text || !btn || !close) return;
  text.textContent = message;
  toast.classList.add('visible');
  // The CSS transitions opacity + transform; display:flex lets it hit-test.
  toast.style.display = 'flex';
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, durationMs || 7000);
  btn.onclick = () => {
    hideUndoToast();
    try { onUndo && onUndo(); } catch (e) { console.error(e); }
  };
  close.onclick = hideUndoToast;
}
function hideUndoToast() {
  const toast = document.getElementById('undo-toast');
  if (!toast) return;
  toast.classList.remove('visible');
  // Match the CSS transition (180ms) before removing from layout.
  setTimeout(() => { toast.style.display = 'none'; }, 200);
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
}

function updateKeypadDisplay() {
  const disp = document.getElementById('kp-display');
  if (!disp) return;
  if (keypadValue === '') {
    disp.textContent = 'Type a number…';
    disp.classList.add('empty');
  } else {
    disp.textContent = keypadValue;
    disp.classList.remove('empty');
  }
  if (!isOverlay) renderController();
  else updateKeypadMatch();
}

function updateKeypadMatch() {
  const m = document.getElementById('kp-match');
  if (!m) return;
  if (keypadValue === '') { m.innerHTML = '&nbsp;'; m.className = 'keypad-match'; return; }
  const idx = findRoutineIndex(keypadValue);
  if (idx >= 0) {
    m.textContent = '✓ ' + (state.routines[idx].title || '(no title)');
    m.className = 'keypad-match found';
  } else {
    m.textContent = '⚠ Not in list — will show number only';
    m.className = 'keypad-match miss';
  }
}

function keypadAppend(d) {
  if (d === '.' && keypadValue.includes('.')) return;
  if (keypadValue.length >= 6) return;
  keypadValue += d;
  updateKeypadDisplay();
}
function keypadBackspace() { keypadValue = keypadValue.slice(0, -1); updateKeypadDisplay(); }
function keypadClear() { keypadValue = ''; updateKeypadDisplay(); }
function keypadShow() {
  if (keypadValue === '') return;
  const val = keypadValue.endsWith('.') ? keypadValue.slice(0, -1) : keypadValue;
  setCurrentFromNumber(val);
  keypadClear();
  saveState();
  render();
}

// ========= DROP-IN =========
function dropInShow() {
  const number = document.getElementById('di-number').value.trim();
  const title = document.getElementById('di-title').value.trim();
  if (!number) { alert('Enter a routine number'); return; }
  setCurrentDropIn(number, title);
  saveState();
  render();
}

function dropInAdd() {
  const number = document.getElementById('di-number').value.trim();
  const title = document.getElementById('di-title').value.trim();
  if (!number) { alert('Enter a routine number'); return; }
  const existingIdx = findRoutineIndex(number);
  let newIdx;
  if (existingIdx >= 0) {
    state.routines[existingIdx].title = title;
    state.routines[existingIdx].addedLive = true;
    newIdx = existingIdx;
  } else {
    newIdx = insertRoutineSorted({ number, title, addedLive: true });
  }
  setCurrentFromIndex(newIdx);
  document.getElementById('di-number').value = '';
  document.getElementById('di-title').value = '';
  saveState();
  render();
}

// ========= STORAGE SYNC =========
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY && !serverMode) {
    loadLocalState();
    applyAllFonts();
    applyOverlayTextStyle(state.overlayTextStyle);
    render();
  }
});

// ========= SETUP =========
if (!isOverlay) {
  document.getElementById('parse-btn').addEventListener('click', () => {
    const text = document.getElementById('routine-input').value;
    const parsed = parseInput(text);
    if (parsed.length === 0) { alert('No routines found. Check your list format.'); return; }
    state.routines = parsed;
    state.current = null;
    saveState();
    render();
  });

  document.getElementById('sample-btn').addEventListener('click', () => {
    document.getElementById('routine-input').value =
`1. Opening Number - All Company
2. Sparkle Toes - Mini Jazz
3. Neon Dreams - Senior Solo - Jane Smith
4. Thunder - Teen Hip Hop
5. Swan Lake Variation - Ballet Solo
6. Fireworks - Junior Lyrical
7. Closing Number`;
  });

  function clearAllRoutines() {
    if (!confirm('Clear all routines?')) return;
    const cleared = state.routines;
    const backup = cleared.length > 0
      ? { routines: cleared, at: new Date().toISOString() }
      : (state.clearedBackup || null);
    state = {
      routines: [], current: null, hidden: false, clearedBackup: backup,
      message: state.message, routineFont: state.routineFont, messageFont: state.messageFont,
      overlayTextStyle: state.overlayTextStyle
    };
    const input = document.getElementById('routine-input');
    if (input) input.value = '';
    saveState();
    render();
    if (cleared.length > 0) {
      const noun = cleared.length === 1 ? 'routine' : 'routines';
      showUndoToast(`Cleared ${cleared.length} ${noun}`, () => {
        state.routines = cleared;
        state.clearedBackup = null;
        saveState();
        render();
      });
    }
  }
  document.getElementById('clear-all-btn').addEventListener('click', clearAllRoutines);
  const headerClear = document.getElementById('clear-list-btn');
  if (headerClear) headerClear.addEventListener('click', clearAllRoutines);

  const resetProgressBtn = document.getElementById('reset-progress-btn');
  if (resetProgressBtn) {
    resetProgressBtn.addEventListener('click', () => {
      state.routines.forEach(r => { delete r.shown; });
      saveState();
      render();
    });
  }

  const recoverBtn = document.getElementById('recover-btn');
  if (recoverBtn) {
    recoverBtn.addEventListener('click', () => {
      if (!state.clearedBackup || !Array.isArray(state.clearedBackup.routines) || state.clearedBackup.routines.length === 0) return;
      if (state.routines.length > 0 && !confirm('This will replace the current routine list with the last cleared list. Continue?')) return;
      state.routines = state.clearedBackup.routines;
      state.current = null;
      state.clearedBackup = null;
      saveState();
      render();
    });
  }

  // PDF upload — shared handler used by button + drag-and-drop
  async function handlePDFFile(file) {
    if (!window.pdfjsLib) { alert('PDF library not loaded. Check your internet connection.'); return; }
    const btn = document.getElementById('pdf-btn');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.textContent = 'Parsing…'; btn.disabled = true; }
    try {
      const routines = await parsePDF(file);
      if (routines.length === 0) {
        alert('No routines found. The PDF may not have numbered entries, or the format is different than expected.');
      } else {
        document.getElementById('routine-input').value =
          routines.map(r => `${r.number}. ${r.title}`).join('\n');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to read PDF: ' + err.message);
    } finally {
      if (btn) { btn.textContent = label; btn.disabled = false; }
    }
  }

  document.getElementById('pdf-btn').addEventListener('click', () => {
    if (!window.pdfjsLib) { alert('PDF library not loaded. Check your internet connection.'); return; }
    document.getElementById('pdf-input').click();
  });
  document.getElementById('pdf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await handlePDFFile(file);
    e.target.value = '';
  });

  // Drag-and-drop PDF anywhere on the window
  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('drag-active');
  });
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  });
  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('drag-active');
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drag-active');
    const file = e.dataTransfer.files[0];
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      alert('Drop a PDF file to load routines.');
      return;
    }
    await handlePDFFile(file);
  });

  // Navigation
  document.getElementById('next-btn').addEventListener('click', () => {
    if (state.routines.length === 0) return;
    const curr = state.current && state.current.fromIndex !== null ? state.current.fromIndex : -1;
    const nextIdx = Math.min(curr + 1, state.routines.length - 1);
    setCurrentFromIndex(nextIdx);
    saveState();
    render();
  });

  document.getElementById('prev-btn').addEventListener('click', () => {
    if (state.routines.length === 0) return;
    const curr = state.current && state.current.fromIndex !== null ? state.current.fromIndex : 0;
    const prevIdx = Math.max(curr - 1, 0);
    setCurrentFromIndex(prevIdx);
    saveState();
    render();
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    if (state.current) {
      // Toggle: hide overlay but keep position so Next/Prev resume from here
      state.hidden = !state.hidden;
    } else {
      state.hidden = false;
    }
    saveState();
    render();
  });

  // Keypad
  document.querySelectorAll('.kp-btn[data-digit]').forEach(btn => {
    btn.addEventListener('click', () => keypadAppend(btn.dataset.digit));
  });
  document.getElementById('kp-back').addEventListener('click', keypadBackspace);
  document.getElementById('kp-clear').addEventListener('click', keypadClear);
  document.getElementById('kp-show').addEventListener('click', keypadShow);

  // Routine overlay font dropdown
  const routineFontSelect = document.getElementById('routine-font-select');
  if (routineFontSelect) {
    routineFontSelect.value = normalizeOverlayFont(state.routineFont);
    routineFontSelect.addEventListener('change', () => {
      state.routineFont = normalizeOverlayFont(routineFontSelect.value);
      applyRoutineFont(state.routineFont);
      saveState();
    });
  }

  // Message overlay font dropdown
  const messageFontSelect = document.getElementById('overlay-font-select');
  if (messageFontSelect) {
    messageFontSelect.value = normalizeOverlayFont(state.messageFont);
    messageFontSelect.addEventListener('change', () => {
      state.messageFont = normalizeOverlayFont(messageFontSelect.value);
      applyMessageFont(state.messageFont);
      saveState();
      // Refresh the live preview so its measurements pick up the new font
      const evt = new Event('input', { bubbles: true });
      const inp = document.getElementById('msg-input');
      if (inp) inp.dispatchEvent(evt);
    });
  }

  // Overlay text-style toggle (shadow / outline / plain) — applies to both
  // overlays + the OBS preview strip via a :root[data-overlay-style] hook.
  const styleToggle = document.getElementById('text-style-toggle');
  if (styleToggle) {
    const syncStyleButtons = () => {
      const active = normalizeOverlayTextStyle(state.overlayTextStyle);
      styleToggle.querySelectorAll('.text-style-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.style === active);
      });
    };
    syncStyleButtons();
    styleToggle.querySelectorAll('.text-style-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.overlayTextStyle = normalizeOverlayTextStyle(btn.dataset.style);
        applyOverlayTextStyle(state.overlayTextStyle);
        syncStyleButtons();
        saveState();
        // Refresh the message-input preview so it visually picks up the new style
        const inp = document.getElementById('msg-input');
        if (inp) inp.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  }

  // Persist the open/closed state of the collapsible setup banners
  ['instructions-details', 'obs-url-banner'].forEach(id => {
    const det = document.getElementById(id);
    if (!det) return;
    const key = 'rt-details-open-' + id;
    const stored = localStorage.getItem(key);
    if (stored === 'true') det.open = true;
    else if (stored === 'false') det.open = false;
    // Default: instructions closed (read-once), URL banner open (frequently used).
    else if (id === 'instructions-details') det.open = false;
    else det.open = true;
    det.addEventListener('toggle', () => {
      try { localStorage.setItem(key, String(det.open)); } catch (_) {}
    });
  });

  // Message overlay
  const msgInput = document.getElementById('msg-input');
  const msgShowBtn = document.getElementById('msg-show');
  const msgHideBtn = document.getElementById('msg-hide');
  const msgPreviewBox = document.querySelector('.ticker-preview');

  function updateMsgPreview() {
    if (!msgPreviewBox || !msgInput) return;
    const text = msgInput.value;
    if (!text || !text.trim()) {
      msgPreviewBox.innerHTML = '<div class="ticker-preview-empty">Type a message to preview…</div>';
      return;
    }
    let track = msgPreviewBox.querySelector('.ticker-track');
    if (!track) {
      msgPreviewBox.innerHTML = '<div class="ticker-track" id="msg-preview-track"></div>';
      track = msgPreviewBox.querySelector('.ticker-track');
    }
    buildTicker(track, text, { viewportWidth: msgPreviewBox.clientWidth });
  }

  if (msgInput && state.message && state.message.text) msgInput.value = state.message.text;
  updateMsgPreview();

  if (msgShowBtn && msgInput) {
    msgShowBtn.addEventListener('click', () => {
      const text = msgInput.value.trim();
      if (!text) { alert('Enter a message first.'); msgInput.focus(); return; }
      state.message = { text, visible: true };
      saveState();
      render();
    });
    msgInput.addEventListener('input', updateMsgPreview);
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') msgShowBtn.click();
    });
  }
  if (msgHideBtn) {
    msgHideBtn.addEventListener('click', () => {
      state.message = { text: (state.message && state.message.text) || '', visible: false };
      saveState();
      render();
    });
  }
  // Re-tile the preview if the window resizes (changes preview box width)
  window.addEventListener('resize', () => {
    if (msgInput && msgInput.value && msgInput.value.trim()) updateMsgPreview();
  });

  // Drop-in
  document.getElementById('di-show').addEventListener('click', dropInShow);
  document.getElementById('di-add').addEventListener('click', dropInAdd);
  document.getElementById('di-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dropInAdd();
  });
  document.getElementById('di-number').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('di-title').focus();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const inField = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
    if (inField) return;
    if (e.key === 'ArrowRight' || e.key === ' ') {
      document.getElementById('next-btn').click(); e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      document.getElementById('prev-btn').click(); e.preventDefault();
    } else if (e.key === 'Escape') {
      if (keypadValue !== '') keypadClear();
      else document.getElementById('clear-btn').click();
    } else if (/^[0-9]$/.test(e.key)) {
      keypadAppend(e.key); e.preventDefault();
    } else if (e.key === '.') {
      keypadAppend('.'); e.preventDefault();
    } else if (e.key === 'Backspace') {
      keypadBackspace(); e.preventDefault();
    } else if (e.key === 'Enter') {
      if (keypadValue !== '') { keypadShow(); e.preventDefault(); }
    }
  });

  updateKeypadDisplay();

  const filterInput = document.getElementById('routine-filter');
  const filterClear = document.getElementById('routine-filter-clear');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      routineFilter = filterInput.value;
      renderController();
    });
  }
  if (filterClear) {
    filterClear.addEventListener('click', () => {
      routineFilter = '';
      if (filterInput) filterInput.value = '';
      renderController();
      filterInput && filterInput.focus();
    });
  }

  // Show Mode toggle — collapses setup-only chrome and enlarges the readout
  const modeToggle = document.getElementById('mode-toggle');
  if (modeToggle) {
    applyShowMode();
    modeToggle.addEventListener('click', () => {
      showMode = !showMode;
      try { localStorage.setItem(SHOW_MODE_KEY, String(showMode)); } catch (_) {}
      applyShowMode();
      // Mode flip changes which card is the keypad's sibling height-wise; the
      // ResizeObserver on .routine-list reacts on its own once layout settles.
    });
  }

  const hideShownBtn = document.getElementById('hide-shown-toggle');
  if (hideShownBtn) {
    const syncHideShownBtn = () => {
      hideShownBtn.classList.toggle('toggle-active', hideShown);
      hideShownBtn.textContent = hideShown ? '✓ Hiding Shown' : 'Hide Shown';
    };
    syncHideShownBtn();
    hideShownBtn.addEventListener('click', () => {
      hideShown = !hideShown;
      try { localStorage.setItem(HIDE_SHOWN_KEY, String(hideShown)); } catch (_) {}
      syncHideShownBtn();
      renderController();
    });
  }

  setInterval(updateElapsedTimer, 1000);

  const routineCard = document.querySelector('.tools-row.main-grid > .card:first-child');
  const routineList = document.getElementById('routine-list');
  const keypadCard = document.querySelector('.tools-row.main-grid > .card:nth-child(2)');
  if (routineCard && routineList && keypadCard && window.ResizeObserver) {
    const sync = () => {
      // When the cards stack vertically (narrow / phone layout), let the CSS
      // rules govern the list height instead of pinning to the keypad.
      const rc = routineCard.getBoundingClientRect();
      const kc = keypadCard.getBoundingClientRect();
      const stacked = kc.top >= rc.bottom - 1;
      if (stacked) {
        routineList.style.height = '';
        routineList.style.maxHeight = '';
        return;
      }
      const siblingH = keypadCard.offsetHeight;
      const listTop = routineList.getBoundingClientRect().top - rc.top;
      const cardStyle = getComputedStyle(routineCard);
      const bottomPad = parseFloat(cardStyle.paddingBottom) + parseFloat(cardStyle.borderBottomWidth);
      const h = Math.max(120, siblingH - listTop - bottomPad);
      routineList.style.height = h + 'px';
      routineList.style.maxHeight = h + 'px';
    };
    const ro = new ResizeObserver(sync);
    ro.observe(keypadCard);
    ro.observe(routineCard);          // stacked/unstacked can flip when the card reflows
    window.addEventListener('resize', sync);
    sync();
  }
}

// Boot sequence: detect server, then render; start polling if server mode
(async () => {
  await detectServerMode();
  await loadCurrentVersion();
  applyAllFonts();
  applyOverlayTextStyle(state.overlayTextStyle);
  updateConnStatus();
  // Sync the dropdowns + style buttons to whatever loaded from storage/server
  // (the listener setup ran before state was loaded, so the initial values
  // reflected the defaults, not the persisted choices).
  const rfs = document.getElementById('routine-font-select');
  if (rfs) rfs.value = normalizeOverlayFont(state.routineFont);
  const fs = document.getElementById('overlay-font-select');
  if (fs) fs.value = normalizeOverlayFont(state.messageFont);
  const styleToggleBoot = document.getElementById('text-style-toggle');
  if (styleToggleBoot) {
    const active = normalizeOverlayTextStyle(state.overlayTextStyle);
    styleToggleBoot.querySelectorAll('.text-style-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.style === active);
    });
  }
  // Same with the message input
  const mi = document.getElementById('msg-input');
  if (mi && state.message && state.message.text) {
    mi.value = state.message.text;
    mi.dispatchEvent(new Event('input', { bubbles: true }));
  }
  render();
  renderFooter();

  // Controller-only UI bits
  if (!isOverlay) {
    // OBS URL banner (only when Electron server is up)
    if (serverMode) {
      const banner = document.getElementById('obs-url-banner');
      if (banner) {
        banner.style.display = 'flex';
        const urls = {
          overlay: `${location.origin}/#overlay`,
          messages: `${location.origin}/#messages`
        };
        banner.querySelector('[data-kind="overlay"]').textContent = urls.overlay;
        banner.querySelector('[data-kind="messages"]').textContent = urls.messages;
        banner.querySelectorAll('.obs-url-copy').forEach(btn => {
          btn.addEventListener('click', async () => {
            const kind = btn.dataset.copy || 'overlay';
            try { await navigator.clipboard.writeText(urls[kind]); } catch (_) {}
            const prev = btn.textContent;
            btn.textContent = 'Copied ✓';
            setTimeout(() => { btn.textContent = prev; }, 1400);
          });
        });
      }
    }

    // Update controls
    const checkBtn = document.getElementById('update-check-btn');
    if (checkBtn) checkBtn.addEventListener('click', () => checkForUpdates(true));
    const autoToggle = document.getElementById('auto-check-toggle');
    if (autoToggle) {
      autoToggle.checked = isAutoCheckEnabled();
      autoToggle.addEventListener('change', (e) => setAutoCheckEnabled(e.target.checked));
    }
    // Auto-check once on startup, if enabled and configured
    if (isAutoCheckEnabled() && UPDATE_MANIFEST_URL) {
      checkForUpdates(false);
    }
  }

  if (serverMode) {
    setInterval(pollServerState, isAnyOverlay ? 400 : 1000);
  } else if (isAnyOverlay) {
    setInterval(() => {
      loadLocalState();
      applyAllFonts();
      applyOverlayTextStyle(state.overlayTextStyle);
      render();
    }, 500);
  }
  // Refresh the connection-status pill every second in the controller —
  // catches the moment a server poll goes stale.
  if (!isAnyOverlay) {
    setInterval(updateConnStatus, 1000);
  }
})();

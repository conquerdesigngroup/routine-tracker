const isOverlay = window.location.hash === '#overlay';
document.body.className = isOverlay ? 'overlay-mode' : 'controller-mode';

const STORAGE_KEY = 'obs-routines-state-v2';
const OLD_STORAGE_KEY = 'obs-routines-state-v1';
const API_URL = '/api/state';

// Where to fetch the update manifest. Leave empty to disable update checks.
// Expected JSON shape:
//   { "version": "1.1.0",
//     "downloadUrl": "https://.../Routine-Tracker-1.1.0-arm64.dmg",
//     "downloadUrlX64": "https://.../Routine-Tracker-1.1.0-x64.dmg",
//     "releaseNotes": "Fixed X, added Y" }
const UPDATE_MANIFEST_URL = '';
const AUTO_CHECK_KEY = 'auto-check-updates';
const LAST_CHECK_KEY  = 'update-last-check';

let currentVersion = '';
let updateInfo = null;

// state.current = null OR { number, title, fromIndex: number|null, isDropIn: bool }
let state = { routines: [], current: null };
let serverMode = false;   // true = sync via server API (Electron); false = localStorage only
let lastServerJSON = '';  // last JSON we've seen from server, for change detection

async function detectServerMode() {
  try {
    const resp = await fetch(API_URL, { method: 'GET', cache: 'no-store' });
    if (resp.ok) {
      serverMode = true;
      const data = await resp.json();
      applyRemoteState(data);
      return;
    }
  } catch (_) {}
  serverMode = false;
  loadLocalState();
}

function applyRemoteState(data) {
  state = {
    routines: Array.isArray(data.routines) ? data.routines : [],
    current: data.current ?? null
  };
  lastServerJSON = JSON.stringify(state);
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        routines: Array.isArray(parsed.routines) ? parsed.routines : [],
        current: parsed.current ?? null
      };
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
    if (txt === lastServerJSON) return;
    lastServerJSON = txt;
    applyRemoteState(JSON.parse(txt));
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
  // Strip trailing style suffix (e.g. "Jazz Solo", "Tap Duo/Trio")
  const styleRx = /\s+(Jazz|Tap|Ballet|Lyrical|Modern|Lyrical\/Modern|Contemporary|Hip Hop|Hip-Hop|Open|Musical Theater|Acro|Pointe|Clogging|Song and Dance|Production)\s+(Solo|Duet|Duo|Trio|Duo\/Trio|Duet\/Trio|Small Group|Large Group|Line|Extended Line|Production)\s*$/i;
  t = t.replace(styleRx, '').trim();
  return t;
}

function extractRoutinesFromLines(lines) {
  const routines = [];
  let lastNum = 0;
  for (const line of lines) {
    const m = line.match(/^(\d{1,4})\s+(.{2,}?)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    // Accept any strictly increasing number — handles skipped numbers (e.g. 181 → 183)
    // while rejecting re-scans of already-seen routines
    if (num <= lastNum) continue;
    const title = cleanTitle(m[2]);
    if (!title) continue;
    if (/^(name|age|show order|letter|group|style)/i.test(title)) continue;
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
  state.current = { number: r.number, title: r.title, fromIndex: i, isDropIn: false };
}

function setCurrentFromNumber(number) {
  const idx = findRoutineIndex(number);
  if (idx >= 0) setCurrentFromIndex(idx);
  else state.current = { number: number, title: '', fromIndex: null, isDropIn: false };
}

function setCurrentDropIn(number, title) {
  state.current = { number, title: title || '', fromIndex: null, isDropIn: true };
}

// ========= RENDERING =========
function renderOverlay() {
  const card = document.getElementById('overlay-card');
  if (!state.current || !state.current.number) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('ov-number').textContent = state.current.number;
  document.getElementById('ov-title').textContent = state.current.title || '';
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
    const badge = state.current.isDropIn ? ' <span class="badge">Drop-in</span>' :
                  (state.current.fromIndex === null ? ' <span class="badge">Manual</span>' : '');
    csTitle.innerHTML = escapeHTML(titleText) + badge;
  }

  const activeIdx = state.current ? state.current.fromIndex : null;

  if (state.routines.length === 0) {
    list.innerHTML = '<div class="empty">No routines loaded yet.<br>Paste your list on the right →</div>';
  } else {
    list.innerHTML = state.routines.map((r, i) => `
      <div class="routine-item ${i === activeIdx ? 'active' : ''}" data-idx="${i}">
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
        state.routines.splice(i, 1);
        if (state.current && state.current.fromIndex === i) state.current = null;
        else if (state.current && state.current.fromIndex > i) state.current.fromIndex--;
        saveState();
        render();
      });
    });

    const active = list.querySelector('.routine-item.active');
    if (active) {
      const listRect = list.getBoundingClientRect();
      const itemRect = active.getBoundingClientRect();
      if (itemRect.top < listRect.top) {
        list.scrollTop += itemRect.top - listRect.top;
      } else if (itemRect.bottom > listRect.bottom) {
        list.scrollTop += itemRect.bottom - listRect.bottom;
      }
    }
  }

  updateKeypadMatch();
}

function render() {
  if (isOverlay) renderOverlay();
  else renderController();
}

// ========= KEYPAD =========
let keypadValue = '';

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
  updateKeypadMatch();
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
  if (e.key === STORAGE_KEY && !serverMode) { loadLocalState(); render(); }
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

  document.getElementById('clear-all-btn').addEventListener('click', () => {
    if (!confirm('Clear all routines?')) return;
    state = { routines: [], current: null };
    document.getElementById('routine-input').value = '';
    saveState();
    render();
  });

  // PDF upload
  document.getElementById('pdf-btn').addEventListener('click', () => {
    if (!window.pdfjsLib) { alert('PDF library not loaded. Check your internet connection.'); return; }
    document.getElementById('pdf-input').click();
  });
  document.getElementById('pdf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const btn = document.getElementById('pdf-btn');
    const label = btn.textContent;
    btn.textContent = 'Parsing…';
    btn.disabled = true;
    try {
      const routines = await parsePDF(file);
      if (routines.length === 0) {
        alert('No routines found. The PDF may not have numbered entries, or the format is different than expected.');
      } else {
        state.routines = routines;
        state.current = null;
        document.getElementById('routine-input').value =
          routines.map(r => `${r.number}. ${r.title}`).join('\n');
        saveState();
        render();
      }
    } catch (err) {
      console.error(err);
      alert('Failed to read PDF: ' + err.message);
    } finally {
      btn.textContent = label;
      btn.disabled = false;
      e.target.value = '';
    }
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
    state.current = null;
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
}

// Boot sequence: detect server, then render; start polling if server mode
(async () => {
  await detectServerMode();
  await loadCurrentVersion();
  render();
  renderFooter();

  // Controller-only UI bits
  if (!isOverlay) {
    // OBS URL banner (only when Electron server is up)
    if (serverMode) {
      const banner = document.getElementById('obs-url-banner');
      if (banner) {
        banner.style.display = 'flex';
        const url = `${location.origin}/#overlay`;
        banner.querySelector('.obs-url-value').textContent = url;
        banner.querySelector('.obs-url-copy').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(url); } catch (_) {}
          const btn = banner.querySelector('.obs-url-copy');
          const prev = btn.textContent;
          btn.textContent = 'Copied ✓';
          setTimeout(() => { btn.textContent = prev; }, 1400);
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
    setInterval(pollServerState, isOverlay ? 400 : 1000);
  } else if (isOverlay) {
    setInterval(() => { loadLocalState(); renderOverlay(); }, 500);
  }
})();

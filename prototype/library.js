/* ------------------------------------------------------------------
   Machado — everything you have written.

   Entries are titled by their first line unless renamed by hand. Search
   and paging run over the already-loaded list; rename and delete go
   straight to the server.
------------------------------------------------------------------- */

'use strict';

const $ = (sel) => document.querySelector(sel);

const PER_PAGE = 10;

const view = {
  docs: [],
  query: '',
  page: 1,
  showExcerpts: true,
  openMenu: null,      // id of the entry whose ... menu is open
  confirming: null,    // id awaiting a second click on Delete
  renaming: null,      // id being renamed in place
};

/* ---------------- Formatting ---------------- */

function relativeTime(iso) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const createdOn = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `Created on ${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
};

// The title is already the first line, so the excerpt starts after it.
function excerptOf(doc) {
  const lines = Backend.plainText(doc.content).split('\n').filter((l) => l.trim());
  const rest = lines.slice(doc.title_manual ? 0 : 1).join(' ').trim();
  if (!rest) return '';
  return rest.length > 160 ? rest.slice(0, 160).trimEnd() + '…' : rest;
}

const icon = (paths, opts = {}) =>
  `<svg viewBox="0 0 24 24" fill="${opts.fill || 'none'}" stroke="${opts.fill ? 'none' : 'currentColor'}"` +
  ` stroke-width="${opts.width || 1.7}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/* ---------------- Rendering ---------------- */

function matching() {
  const q = view.query.trim().toLowerCase();
  if (!q) return view.docs;
  return view.docs.filter((d) =>
    ((d.title || '') + ' ' + Backend.plainText(d.content)).toLowerCase().includes(q)
  );
}

function render() {
  const list = matching();
  const pageCount = Math.max(1, Math.ceil(list.length / PER_PAGE));
  if (view.page > pageCount) view.page = pageCount;
  const page = list.slice((view.page - 1) * PER_PAGE, view.page * PER_PAGE);
  const q = view.query.trim();

  $('#count').textContent = q
    ? `${list.length} ${list.length === 1 ? 'match' : 'matches'}`
    : `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`;
  $('#search-clear').hidden = !q;

  const rows = $('#rows');
  rows.innerHTML = '';
  page.forEach((doc) => rows.appendChild(rowNode(doc)));

  const state = $('#state');
  if (!view.docs.length) {
    state.innerHTML = 'Nothing here yet. <a href="index.html">Start writing →</a>';
    state.hidden = false;
  } else if (!list.length) {
    state.textContent = `No entries match “${q}”`;
    state.hidden = false;
  } else {
    state.hidden = true;
  }

  renderPager(pageCount);
}

function renderPager(pageCount) {
  $('#pager').hidden = pageCount < 2;
  $('#prev-page').disabled = view.page === 1;
  $('#next-page').disabled = view.page === pageCount;
  const nums = $('#page-nums');
  nums.innerHTML = '';
  for (let i = 1; i <= pageCount; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'num';
    b.textContent = i;
    if (i === view.page) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => { view.page = i; render(); });
    nums.appendChild(b);
  }
}

function rowNode(doc) {
  const row = document.createElement('div');
  row.className = 'row' + (view.openMenu === doc.id ? ' menu-open' : '');

  const link = document.createElement('a');
  link.className = 'row-open';
  link.href = `index.html?doc=${encodeURIComponent(doc.id)}`;

  if (view.renaming === doc.id) {
    link.appendChild(renameField(doc));
    link.addEventListener('click', (e) => e.preventDefault());
  } else {
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = doc.title || 'Untitled';
    link.appendChild(title);
  }

  const excerpt = view.showExcerpts ? excerptOf(doc) : '';
  if (excerpt) {
    const ex = document.createElement('div');
    ex.className = 'row-excerpt';
    ex.textContent = excerpt;
    link.appendChild(ex);
  }

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.innerHTML = '<span></span><span class="dot">·</span><span></span>';
  meta.children[0].textContent = relativeTime(doc.updated_at);
  meta.children[2].textContent = createdOn(doc.created_at);
  link.appendChild(meta);

  row.append(link, actionsNode(doc));
  return row;
}

function renameField(doc) {
  const wrap = document.createElement('div');
  wrap.className = 'rename';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = doc.title || '';
  input.setAttribute('aria-label', 'Entry title');
  input.addEventListener('click', (e) => e.preventDefault());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(doc, input.value); }
    if (e.key === 'Escape') { e.preventDefault(); view.renaming = null; render(); }
  });
  input.addEventListener('blur', () => {
    if (view.renaming === doc.id) commitRename(doc, input.value);
  });

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'rename-ok';
  ok.setAttribute('aria-label', 'Save title');
  ok.innerHTML = icon('<path d="M4.5 12.5l5 5 10-11"/>', { width: 2.1 });
  // mousedown, so it fires before the input's blur steals the commit
  ok.addEventListener('mousedown', (e) => { e.preventDefault(); commitRename(doc, input.value); });

  wrap.append(input, ok);
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return wrap;
}

function actionsNode(doc) {
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const dots = document.createElement('button');
  dots.type = 'button';
  dots.className = 'dots';
  dots.dataset.rowMenuBtn = 'true';
  dots.setAttribute('aria-label', 'Entry options');
  dots.innerHTML = icon(
    '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>',
    { fill: 'currentColor' }
  );
  dots.addEventListener('click', (e) => {
    e.preventDefault();
    view.openMenu = view.openMenu === doc.id ? null : doc.id;
    view.confirming = null;
    render();
  });
  actions.appendChild(dots);

  if (view.openMenu === doc.id) {
    const menu = document.createElement('div');
    menu.className = 'menu row-menu';
    menu.dataset.rowMenu = 'true';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.innerHTML = icon('<path d="M16.5 3.5l4 4L8 20H4v-4z"/>') + 'Rename';
    rename.addEventListener('click', (e) => {
      e.preventDefault();
      view.renaming = doc.id;
      view.openMenu = null;
      render();
    });

    // Entries are deleted for good, so the first click only arms it.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    const armed = view.confirming === doc.id;
    del.innerHTML =
      icon('<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>') +
      (armed ? 'Delete for good?' : 'Delete');
    del.addEventListener('click', (e) => {
      e.preventDefault();
      if (!armed) { view.confirming = doc.id; render(); return; }
      removeDoc(doc);
    });

    menu.append(rename, del);
    actions.appendChild(menu);
  }

  return actions;
}

/* ---------------- Mutations ---------------- */

async function commitRename(doc, value) {
  const title = value.trim();
  view.renaming = null;
  if (!title || title === doc.title) { render(); return; }

  const previous = doc.title;
  doc.title = title;              // optimistic: the list updates at once
  doc.title_manual = true;
  render();
  try {
    await Backend.renameDocument(doc.id, title);
  } catch (err) {
    doc.title = previous;
    render();
    showError(`Could not rename that entry: ${err.message}`);
  }
}

async function removeDoc(doc) {
  view.openMenu = null;
  view.confirming = null;
  const index = view.docs.findIndex((d) => d.id === doc.id);
  const [removed] = view.docs.splice(index, 1);
  render();
  try {
    await Backend.deleteDocument(doc.id);
  } catch (err) {
    view.docs.splice(index, 0, removed);   // put it back
    render();
    showError(`Could not delete that entry: ${err.message}`);
  }
}

function showError(message) {
  const state = $('#state');
  state.textContent = message;
  state.hidden = false;
}

/* ---------------- Account ---------------- */

function initialsFor(user) {
  const name = user.user_metadata?.full_name || user.user_metadata?.name;
  if (name) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0][0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  }
  return (user.email || '?').slice(0, 2).toUpperCase();
}

const accountMenu = () => $('#account-menu');

function toggleAccountMenu(open) {
  const menu = accountMenu();
  const next = open ?? menu.hidden;
  menu.hidden = !next;
  $('#avatar-btn').setAttribute('aria-expanded', String(next));
}

/* ---------------- Settings ---------------- */

function showSettings(on) {
  $('#library-view').hidden = on;
  $('#settings-view').hidden = !on;
  document.title = on ? 'Settings · Machado' : 'Entries · Machado';
}

// The theme belongs to the account, so changing it here reaches the
// editor too. The localStorage mirror is what lets every page paint the
// right palette before its preferences arrive (see theme-boot.js).
function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').setAttribute('aria-checked', String(theme === 'dark'));
  try { localStorage.setItem('machado-theme', theme); } catch { /* ignore */ }
  if (persist) {
    Backend.savePreferences({ theme }).catch(() => {
      /* it still applies on this device; the next save will catch up */
    });
  }
}

function setShowExcerpts(on, persist = true) {
  view.showExcerpts = on;
  $('#excerpt-toggle').setAttribute('aria-checked', String(on));
  render();
  if (persist) {
    Backend.savePreferences({ show_excerpts: on }).catch(() => {
      /* a display preference is not worth interrupting anyone over */
    });
  }
}

/* ---------------- Wiring ---------------- */

$('#new-entry').addEventListener('click', () => { location.href = 'index.html?new=1'; });

$('#search-input').addEventListener('input', (e) => {
  view.query = e.target.value;
  view.page = 1;
  render();
});

$('#search-clear').addEventListener('click', () => {
  $('#search-input').value = '';
  view.query = '';
  view.page = 1;
  render();
  $('#search-input').focus();
});

$('#prev-page').addEventListener('click', () => { view.page = Math.max(1, view.page - 1); render(); });
$('#next-page').addEventListener('click', () => { view.page += 1; render(); });

$('#avatar-btn').addEventListener('click', () => toggleAccountMenu());

$('#open-settings').addEventListener('click', () => { toggleAccountMenu(false); showSettings(true); });
$('#back-to-library').addEventListener('click', () => showSettings(false));
$('#excerpt-toggle').addEventListener('click', () => setShowExcerpts(!view.showExcerpts));

$('#theme-toggle').addEventListener('click', () => {
  const isDark = document.documentElement.dataset.theme === 'dark';
  setTheme(isDark ? 'light' : 'dark');
});

$('#sign-out').addEventListener('click', async () => {
  await Backend.signOut();
  location.replace(Backend.pageUrl('login.html'));
});

// Anything opened by a click closes when the click lands elsewhere.
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!t.closest('#avatar-btn') && !t.closest('#account-menu') && !accountMenu().hidden) {
    toggleAccountMenu(false);
  }
  if (!t.closest('[data-row-menu-btn]') && !t.closest('[data-row-menu]') && view.openMenu !== null) {
    view.openMenu = null;
    view.confirming = null;
    render();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!accountMenu().hidden) { toggleAccountMenu(false); return; }
  if (view.openMenu !== null) { view.openMenu = null; view.confirming = null; render(); }
});

/* ---------------- Boot ---------------- */

// theme-boot.js already painted the last known theme; confirm it against
// the account in case it changed on another device.
function applyPreferences(prefs) {
  const theme =
    prefs?.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  setTheme(theme, false);
  if (prefs && prefs.show_excerpts === false) setShowExcerpts(false, false);
}

(async () => {
  const session = await Backend.requireAuth();
  if (!session) return;

  $('#avatar-btn').textContent = initialsFor(session.user);
  $('#avatar-btn').title = session.user.email || 'Account';

  try {
    applyPreferences(await Backend.loadPreferences());
  } catch { /* keep whatever theme-boot chose */ }

  try {
    view.docs = await Backend.listDocuments();
    render();
  } catch (err) {
    showError(`Could not load your entries: ${err.message}`);
  }
})();

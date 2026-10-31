/* ------------------------------------------------------------------
   Machado — the editor.
   A rich-text surface with tabs, where each tab is a view onto one
   document in your account. Edits autosave; backend.js does the
   talking to the server.
------------------------------------------------------------------- */

'use strict';

const $ = (sel) => document.querySelector(sel);

// Four faces ship with both macOS and Windows; the other three are
// self-hosted (see @font-face in style.css) so the menu renders the
// same typeface on every platform instead of silently falling back.
const FONTS = [
  { name: 'Georgia',         stack: `Georgia, 'Times New Roman', serif` },
  { name: 'Times New Roman', stack: `'Times New Roman', Times, serif` },
  { name: 'Palatino',        stack: `Palatino, 'Palatino Linotype', 'Book Antiqua', 'URW Palladio L', serif` },
  { name: 'Inter',           stack: `Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif` },
  { name: 'Work Sans',       stack: `'Work Sans', 'Avenir Next', Avenir, 'Segoe UI', sans-serif` },
  { name: 'Courier New',     stack: `'Courier New', Courier, monospace` },
  { name: 'Literata',        stack: `Literata, 'Iowan Old Style', Georgia, serif` },
];

// Renamed faces map to their replacements so a saved preference survives
const FONT_ALIASES = {
  Helvetica: 'Inter',
  Avenir: 'Work Sans',
  'Iowan Old Style': 'Literata',
};

const IS_MAC = /mac/i.test(
  navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
);

// Menu shortcuts are authored once in Mac notation (⇧⌘S) and rendered as
// Ctrl+Shift+S on Windows and Linux. Key handling already accepts either
// modifier, so only the label needs translating.
function shortcutLabel(key) {
  if (!key || IS_MAC) return key;
  const mods = [];
  if (key.includes('⌘') || key.includes('⌃')) mods.push('Ctrl');
  if (key.includes('⌥')) mods.push('Alt');
  if (key.includes('⇧')) mods.push('Shift');
  return mods.concat(key.replace(/[⌘⇧⌥⌃]/g, '').replace('−', '-')).join('+');
}

// Narrow is both the default and the floor: a line of roughly a dozen
// words. The wider steps exist for people who want them.
const COLUMN_WIDTHS = ['Narrow', 'Medium', 'Wide', 'Full'];
const DEFAULT_COLUMN = 'Narrow';

const DEFAULT_FONT = 'Georgia';
const BASE_FONT_PX = 17;
const ZOOM_MIN = 50, ZOOM_MAX = 200, ZOOM_STEP = 10;

/* ---------------- Text <-> HTML helpers ---------------- */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain text -> one <div> per line (the contenteditable line model).
// Used when importing local drafts written before accounts existed.
function textToHtml(text) {
  return text
    .split('\n')
    .map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`)
    .join('');
}

const BLOCK_RE = /^(DIV|P)$/;

// Walk an element's contents producing plain text (one \n per line) and,
// optionally, the list of text nodes with their offsets into that text.
// Every consumer (status bar, find, save-as-txt) uses this walker so
// offsets always agree.
function collectText(root) {
  const parts = [];
  let text = '';
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push({ node: n, start: text.length });
        text += n.nodeValue;
      } else if (n.nodeName === 'BR') {
        // A <br> that's the only/last thing in a block is that block's
        // empty-line placeholder — the block itself contributes the \n
        if (!(BLOCK_RE.test(n.parentNode?.nodeName) && n === n.parentNode.lastChild)) {
          text += '\n';
        }
      } else if (n.childNodes) {
        walk(n.childNodes);
        if (BLOCK_RE.test(n.nodeName)) text += '\n';
      }
    }
  })(root.childNodes);
  return { text, parts };
}

const plainTextOf = (el) => collectText(el).text.replace(/\n$/, '');

// Keep only the formatting we support; strip everything else on paste/open
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'DIV', 'P', 'BR']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'IMG', 'VIDEO', 'IFRAME', 'OBJECT']);

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = (nodes) => {
    let s = '';
    for (const n of nodes) {
      if (n.nodeType === Node.TEXT_NODE) s += escapeHtml(n.nodeValue);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (DROP_TAGS.has(n.nodeName)) continue;
        if (n.nodeName === 'BR') s += '<br>';
        else if (ALLOWED_TAGS.has(n.nodeName)) {
          const tag = n.nodeName === 'P' ? 'div' : n.nodeName.toLowerCase();
          s += `<${tag}>${out(n.childNodes)}</${tag}>`;
        } else {
          s += out(n.childNodes); // unwrap unknown tags, keep their text
        }
      }
    }
    return s;
  };
  return out(doc.body.childNodes);
}

/* ---------------- Output (export & print) ----------------
   Documents live in the account now, so there is nothing to "save to
   disk" — Export hands you a copy to keep. */

function download(name, content, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function printDocument(html, fontStack, align) {
  const root = $("#print-root");
  root.innerHTML = html;
  root.style.fontFamily = fontStack;
  root.style.textAlign = align;
  window.print();
}

/* ---------------- State ---------------- */

const state = {
  tabs: [],          // Tab objects, in strip order
  activeId: null,
  font: DEFAULT_FONT,
  zoom: 100,
  align: 'left',     // 'left' | 'right' | 'justify'
  columnWidth: DEFAULT_COLUMN,
  theme: null,       // 'light' | 'dark'; resolved from system on first launch
};

let tabIdCounter = 1;

/* ---------------- Tabs ---------------- */

function createTab({ docId = null, title = null, content = '', titleManual = false } = {}) {
  const id = tabIdCounter++;
  const tab = {
    id,
    docId,                    // row in `documents`; null until the first words
    title: title || 'Untitled',
    titleManual,              // renamed by hand? then stop deriving the title
    savedHtml: '',            // innerHTML as of the last confirmed save
    saveTimer: null,
    saving: false,
    el: null, editor: null,
  };

  // Tab strip element
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.role = 'tab';
  tabEl.dataset.id = id;
  tabEl.innerHTML = `
    <span class="tab-dot" title="Unsaved changes"></span>
    <span class="tab-title"></span>
    <button class="tab-close" title="Close tab (⌘W)" aria-label="Close tab">✕</button>`;
  tabEl.querySelector('.tab-title').textContent = tab.title;
  tabEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tab-close')) return;
    activateTab(id);
  });
  tabEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tab-close')) return;
    e.preventDefault();
    beginRename(tab);
  });
  tabEl.querySelector('.tab-close').addEventListener('click', () => closeTab(id));
  tab.el = tabEl;
  $('#tabs').appendChild(tabEl);

  // Editor pane
  const doc = document.createElement('div');
  doc.className = 'doc';
  doc.hidden = true;
  doc.innerHTML = `
    <div class="doc-column">
      <div class="doc-text" contenteditable="true" spellcheck="true"></div>
      <div class="doc-scrollbar" aria-hidden="true"><div class="doc-thumb"></div></div>
    </div>`;
  const editor = doc.querySelector('.doc-text');
  editor.innerHTML = content;
  tab.savedHtml = editor.innerHTML;   // as loaded from the server
  editor.addEventListener('input', () => {
    updateTabChrome(tab);
    updateStatus();
    if (find.active) find.refresh();
    scheduleSave(tab);
  });
  ['keyup', 'click'].forEach((ev) => editor.addEventListener(ev, updateStatus));

  // Paste: keep only our formatting, never colors/images/etc.
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
    else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // Clicking the margins beside the column should still land in the editor
  doc.addEventListener('mousedown', (e) => {
    if (e.target === doc || e.target === doc.firstElementChild) {
      e.preventDefault();
      editor.focus();
    }
  });

  // Custom overlay scrollbar: fades in on scroll, fades out after 1.5s of rest
  const scrollbar = doc.querySelector('.doc-scrollbar');
  const thumb = doc.querySelector('.doc-thumb');
  let scrollbarTimer = null;
  let dragging = false;

  const scrollMax = () => editor.scrollHeight - editor.clientHeight;

  function refreshScrollbar() {
    if (scrollMax() <= 1) return false;
    const track = scrollbar.clientHeight;
    const th = Math.max(30, (track * editor.clientHeight) / editor.scrollHeight);
    thumb.style.height = th + 'px';
    thumb.style.top = (editor.scrollTop / scrollMax()) * (track - th) + 'px';
    return true;
  }

  function showScrollbar() {
    if (!refreshScrollbar()) {
      scrollbar.classList.remove('visible');
      return;
    }
    scrollbar.classList.add('visible');
    clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(() => {
      if (!dragging) scrollbar.classList.remove('visible');
    }, 1500);
  }

  editor.addEventListener('scroll', showScrollbar);

  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    thumb.classList.add('dragging');
    const startY = e.clientY;
    const startScroll = editor.scrollTop;
    const track = scrollbar.clientHeight - thumb.offsetHeight;
    const onMove = (ev) =>
      (editor.scrollTop = startScroll + ((ev.clientY - startY) / track) * scrollMax());
    const onUp = () => {
      dragging = false;
      thumb.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      showScrollbar(); // restart the fade-out timer
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  scrollbar.addEventListener('mousedown', (e) => {
    if (e.target !== scrollbar) return;
    const th = thumb.offsetHeight;
    const y = e.clientY - scrollbar.getBoundingClientRect().top - th / 2;
    editor.scrollTop = (y / (scrollbar.clientHeight - th)) * scrollMax();
  });

  tab.editor = editor;
  $('#editor').appendChild(doc);
  tab.docEl = doc;

  state.tabs.push(tab);
  updateTabChrome(tab);
  return tab;
}

function activateTab(id) {
  state.activeId = id;
  for (const tab of state.tabs) {
    const active = tab.id === id;
    tab.el.classList.toggle('active', active);
    tab.docEl.hidden = !active;
  }
  const tab = activeTab();
  if (tab) {
    tab.editor.focus();
    document.title = tab.title + (isDirty(tab) ? ' •' : '');
  }
  if (find.active) find.refresh();
  updateStatus();
  rememberOpenTabs();
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

// Closing a tab puts the document away; it stays in your library.
function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = state.tabs.splice(idx, 1);
  if (isDirty(tab)) saveTab(tab);
  tab.el.remove();
  tab.docEl.remove();
  if (state.tabs.length === 0) {
    activateTab(createTab().id);
  } else if (state.activeId === id) {
    activateTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
  } else {
    rememberOpenTabs();
  }
}

function cycleTab(delta) {
  if (state.tabs.length < 2) return;
  const idx = state.tabs.findIndex((t) => t.id === state.activeId);
  const next = (idx + delta + state.tabs.length) % state.tabs.length;
  activateTab(state.tabs[next].id);
}

function isDirty(tab) {
  return tab.editor.innerHTML !== tab.savedHtml;
}

function updateTabChrome(tab) {
  const dirty = isDirty(tab);
  tab.el.classList.toggle('dirty', dirty);
  // the title is an <input> mid-rename, so this may legitimately be absent
  const titleEl = tab.el.querySelector('.tab-title');
  if (titleEl) titleEl.textContent = tab.title;
  tab.el.title = tab.title;
  if (tab.id === state.activeId) document.title = tab.title + (dirty ? ' •' : '');
}

/* ---------------- Renaming ----------------
   A document is named after its first line until you say otherwise.
   Renaming pins the name, so writing on no longer rewrites it.       */

function beginRename(tab) {
  if (!tab || tab.renaming) return;
  activateTab(tab.id);
  tab.renaming = true;

  const titleEl = tab.el.querySelector('.tab-title');
  if (!titleEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-rename';
  input.value = tab.title;
  input.setAttribute('aria-label', 'Entry title');

  const finish = (commit) => {
    if (!tab.renaming) return;
    tab.renaming = false;
    const next = input.value.trim();
    input.replaceWith(titleEl);          // put the label back first
    if (commit && next && next !== tab.title) commitRename(tab, next);
    else updateTabChrome(tab);
    tab.editor.focus();
  };

  // keep the editor's own shortcuts out of the field
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());

  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

async function commitRename(tab, title) {
  tab.title = title;
  tab.titleManual = true;
  updateTabChrome(tab);
  rememberOpenTabs();
  // A tab with no words yet has no row to rename; the name is held and
  // travels with the document when it is first written.
  if (!tab.docId) return;
  try {
    await Backend.renameDocument(tab.docId, title);
  } catch (err) {
    setSyncStatus('offline');
    console.warn('rename failed, kept locally:', err.message);
  }
}

/* ---------------- File commands ---------------- */

// Standalone HTML document written to disk for .html saves
function htmlDoc(tab) {
  const font = currentFontStack().replace(/"/g, "'");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(tab.title)}</title>
<style>body { font-family: ${font}; line-height: 1.65; max-width: 34em; margin: 2em auto; padding: 0 1em; text-align: ${state.align}; }</style>
</head>
<body>
${tab.editor.innerHTML}
</body>
</html>
`;
}

const safeFileName = (title) =>
  (title || "Untitled").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "Untitled";

function cmdExport(format) {
  const tab = activeTab();
  if (!tab) return;
  const name = safeFileName(tab.title);
  if (format === "html") {
    download(name + ".html", htmlDoc(tab), "text/html");
  } else {
    download(name + ".txt", plainTextOf(tab.editor), "text/plain");
  }
}

function cmdLibrary() {
  location.href = "library.html";
}

function cmdPrint() {
  const tab = activeTab();
  if (!tab) return;
  printDocument(tab.editor.innerHTML, currentFontStack(), state.align);
}

async function cmdSignOut() {
  await flushAll();
  await Backend.signOut();
  location.replace(Backend.pageUrl("login.html"));
}

/* ---------------- Edit commands ---------------- */

function withEditorFocus(fn) {
  const tab = activeTab();
  if (!tab) return;
  tab.editor.focus();
  fn(tab.editor);
  updateStatus();
}

const editCommands = {
  undo: () => withEditorFocus(() => document.execCommand('undo')),
  redo: () => withEditorFocus(() => document.execCommand('redo')),
  cut: () => withEditorFocus(() => document.execCommand('cut')),
  copy: () => withEditorFocus(() => document.execCommand('copy')),
  paste: () =>
    withEditorFocus(async () => {
      try {
        const text = await navigator.clipboard.readText();
        document.execCommand('insertText', false, text);
      } catch {
        // Clipboard permission unavailable in-browser; native paste still works
      }
    }),
  selectAll: () => withEditorFocus(() => document.execCommand('selectAll')),
  bold: () => withEditorFocus(() => document.execCommand('bold')),
  italic: () => withEditorFocus(() => document.execCommand('italic')),
  underline: () => withEditorFocus(() => document.execCommand('underline')),
  strikethrough: () => withEditorFocus(() => document.execCommand('strikeThrough')),
};

/* ---------------- Find (CSS Custom Highlight API) ---------------- */

const find = {
  active: false,
  matches: [],   // [{ range, start }]
  current: -1,

  open() {
    this.active = true;
    $('#gotobar').hidden = true;
    $('#findbar').hidden = false;
    const input = $('#find-input');
    const tab = activeTab();
    if (tab) {
      const sel = getSelection();
      const selText = sel && tab.editor.contains(sel.anchorNode) ? sel.toString() : '';
      if (selText && selText.length < 100 && !selText.includes('\n')) input.value = selText;
    }
    input.focus();
    input.select();
    this.refresh();
  },

  close() {
    this.active = false;
    $('#findbar').hidden = true;
    const cur = this.matches[this.current];
    this.clearHighlights();
    this.matches = [];
    this.current = -1;
    const tab = activeTab();
    if (tab) {
      tab.editor.focus();
      if (cur) {
        // leave the caret at the match the user was on
        const r = cur.range.cloneRange();
        r.collapse(true);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  },

  refresh() {
    const tab = activeTab();
    if (!tab || !this.active) return;
    const query = $('#find-input').value.toLowerCase();
    this.matches = [];
    if (query) {
      const { text, parts } = collectText(tab.editor);
      const lower = text.toLowerCase();
      const rangeFor = (from, to) => {
        const sp = parts.find((p) => from >= p.start && from < p.start + p.node.nodeValue.length);
        const ep = parts.find((p) => to > p.start && to <= p.start + p.node.nodeValue.length);
        if (!sp || !ep) return null;
        const r = document.createRange();
        r.setStart(sp.node, from - sp.start);
        r.setEnd(ep.node, to - ep.start);
        return r;
      };
      let i = lower.indexOf(query);
      while (i !== -1 && this.matches.length < 5000) {
        const range = rangeFor(i, i + query.length);
        if (range) this.matches.push({ range, start: i });
        i = lower.indexOf(query, i + query.length);
      }
    }
    if (this.current >= this.matches.length || this.current === -1) {
      this.current = this.matches.length ? 0 : -1;
    }
    this.render();
    this.updateCount();
  },

  go(delta) {
    if (!this.matches.length) return;
    this.current = (this.current + delta + this.matches.length) % this.matches.length;
    this.render();
    this.updateCount();
    const tab = activeTab();
    const r = this.matches[this.current].range.getBoundingClientRect();
    const er = tab.editor.getBoundingClientRect();
    tab.editor.scrollTop += r.top - er.top - tab.editor.clientHeight / 3;
  },

  render() {
    if (!('highlights' in CSS)) return;
    this.clearHighlights();
    if (!this.matches.length) return;
    CSS.highlights.set('find-match', new Highlight(...this.matches.map((m) => m.range)));
    if (this.current >= 0) {
      CSS.highlights.set('find-current', new Highlight(this.matches[this.current].range));
    }
  },

  clearHighlights() {
    if (!('highlights' in CSS)) return;
    CSS.highlights.delete('find-match');
    CSS.highlights.delete('find-current');
  },

  updateCount() {
    const el = $('#find-count');
    if (!$('#find-input').value) el.textContent = '';
    else if (!this.matches.length) el.textContent = 'No matches';
    else el.textContent = `${this.current + 1} of ${this.matches.length}`;
  },
};

/* ---------------- Go to line ---------------- */

const goTo = {
  open() {
    find.close();
    $('#gotobar').hidden = false;
    const input = $('#goto-input');
    input.value = '';
    const tab = activeTab();
    if (tab) input.max = visualLineCount(tab.editor);
    input.focus();
  },

  close() {
    $('#gotobar').hidden = true;
    const tab = activeTab();
    if (tab) tab.editor.focus();
  },

  go() {
    const tab = activeTab();
    if (!tab) return;
    const editor = tab.editor;
    const n = Math.max(1, Math.min(parseInt($('#goto-input').value, 10) || 1, visualLineCount(editor)));
    this.close();

    // Rows are the same ones Ln counts, so the number on screen is the
    // number to type. Scroll first: a row can only be hit-tested on screen.
    const { step, firstLineTop } = lineMetrics(editor);
    const rowTop = firstLineTop + (n - 1) * step;
    editor.scrollTop += rowTop - editor.getBoundingClientRect().top - editor.clientHeight / 3;

    const { firstLineTop: top, contentLeft } = lineMetrics(editor);
    const r = rangeAtPoint(contentLeft + 1, top + (n - 1) * step + step / 2);
    if (r && editor.contains(r.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    updateStatus();
  },
};

/* ---------------- Zoom, font, alignment, theme ---------------- */

function setZoom(zoom) {
  state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  $('#editor').style.fontSize = (BASE_FONT_PX * state.zoom) / 100 + 'px';
  updateStatus();
  const el = $('#status-zoom');
  el.hidden = state.zoom === 100;
  el.textContent = state.zoom + '%';
  schedulePrefsSave();
}

function currentFontStack() {
  return (FONTS.find((f) => f.name === state.font) || FONTS[0]).stack;
}

function setFont(name) {
  const resolved = FONT_ALIASES[name] || name;
  state.font = FONTS.some((f) => f.name === resolved) ? resolved : DEFAULT_FONT;
  $('#editor').style.fontFamily = currentFontStack();
  updateStatus();
  renderMenus();
  schedulePrefsSave();
}

function setAlign(name) {
  state.align = ['left', 'right', 'justify'].includes(name) ? name : 'left';
  $('#editor').style.textAlign = state.align;
  renderMenus();
  schedulePrefsSave();
}

function setColumnWidth(name) {
  state.columnWidth = COLUMN_WIDTHS.includes(name) ? name : DEFAULT_COLUMN;
  // a data attribute rather than an inline style, so the phone media
  // query can still override it
  document.documentElement.dataset.col = state.columnWidth.toLowerCase();
  updateStatus();
  renderMenus();
  schedulePrefsSave();
}

function setTheme(name) {
  state.theme = name === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  // Mirrored locally so every page can paint correctly before the
  // preferences round trip finishes (see theme-boot.js).
  try { localStorage.setItem('machado-theme', state.theme); } catch { /* ignore */ }
  renderMenus();
  schedulePrefsSave();
}

/* ---------------- Status bar ---------------- */

// Which line you are on as the eye sees it. A wrapped paragraph is many
// lines, not one, so the number answers "where am I on the page" and moves
// with the column width. Measured from laid-out geometry rather than
// counted from the text, which is also cheaper than walking the document.

function lineMetrics(editor) {
  const cs = getComputedStyle(editor);
  const box = editor.getBoundingClientRect();
  return {
    step: parseFloat(cs.lineHeight),
    // The first line's top, taken from the content box. A range collapsed to
    // the editor element itself reports a zero rect, so it cannot be the
    // reference; the box always can.
    firstLineTop: box.top + parseFloat(cs.paddingTop) - editor.scrollTop,
    contentLeft: box.left + parseFloat(cs.paddingLeft),
  };
}

function visualLineCount(editor) {
  const { step, firstLineTop } = lineMetrics(editor);
  const all = document.createRange();
  all.selectNodeContents(editor);
  const { bottom, height } = all.getBoundingClientRect();
  if (!step || !height) return 1;
  return Math.max(1, Math.round((bottom - firstLineTop) / step));
}

// The caret position nearest a point on screen. Browsers differ on which of
// these two calls they have.
function rangeAtPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }
  return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
}

// At the very start of a wrapped row a collapsed range still reports the end
// of the row above. The character after the caret is always on the caret's
// own row, so measure that when there is one.
function caretRect(caret) {
  const node = caret.endContainer;
  if (caret.collapsed && node.nodeType === Node.TEXT_NODE && caret.endOffset < node.length) {
    const next = document.createRange();
    next.setStart(node, caret.endOffset);
    next.setEnd(node, caret.endOffset + 1);
    const r = next.getBoundingClientRect();
    if (r.height) return r;
  }
  return caret.getBoundingClientRect();
}

function visualLine(editor) {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return null;
  const caret = sel.getRangeAt(0);
  if (!editor.contains(caret.endContainer)) return null;

  const rect = caretRect(caret);
  let caretTop = rect && (rect.height || rect.top) ? rect.top : null;

  // On a blank line the caret sits on the element rather than in a text
  // node, and such a range reports a zero rect — fall back to the block's
  // own box, which is that line.
  if (caretTop === null) {
    let node = caret.endContainer;
    // A boundary on the editor itself points between blocks rather than at
    // a line, so step into the block it refers to.
    if (node === editor) {
      const blocks = editor.children;
      node = blocks[Math.min(caret.endOffset, blocks.length - 1)] || editor;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
    const box = node && node.getBoundingClientRect();
    if (!box || !box.height) return null;
    caretTop = box.top;
  }

  const { step, firstLineTop } = lineMetrics(editor);
  if (!step) return null;

  // A text caret sits below its line box by the half-leading, a block's box
  // sits exactly on it. A quarter-line cushion absorbs both, and sub-pixel
  // layout, without ever reaching the next row.
  return Math.max(1, Math.floor((caretTop - firstLineTop + step * 0.25) / step) + 1);
}

function updateStatus() {
  const tab = activeTab();
  if (!tab) return;
  const text = plainTextOf(tab.editor);
  $('#status-pos').textContent = `Ln ${visualLine(tab.editor) ?? 1}`;
  const words = (text.match(/\S+/g) || []).length;
  $('#status-words').textContent =
    words.toLocaleString() + (words === 1 ? ' word' : ' words');
  $('#status-count').textContent =
    text.length.toLocaleString() + (text.length === 1 ? ' character' : ' characters');
}

/* ---------------- Cloud sync ----------------
   A tab is a view onto a row in your account. Edits land in localStorage
   immediately and reach the server a beat later, so a dropped connection
   or a closed laptop costs nothing. Documents are created lazily: an
   empty tab you never type in is never stored.                        */

const SAVE_DEBOUNCE_MS = 800;
const OPEN_TABS_KEY = 'machado-open-tabs-v1';

let syncStatus = 'idle'; // 'idle' | 'saving' | 'saved' | 'offline'

function setSyncStatus(next) {
  syncStatus = next;
  const el = $('#status-sync');
  if (!el) return;
  const label = { idle: '', saving: 'Saving…', saved: 'Saved', offline: 'Offline — kept on this device' };
  el.textContent = label[next] || '';
  el.hidden = !label[next];
  el.classList.toggle('is-offline', next === 'offline');
}

// Which documents this device has open. Deliberately per-device: your
// writing follows you everywhere, your desk arrangement does not.
function rememberOpenTabs() {
  const ids = state.tabs.map((t) => t.docId).filter(Boolean);
  const activeDocId = activeTab()?.docId || null;
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ ids, activeDocId }));
  } catch { /* private mode — tabs just won't be remembered */ }
}

function readOpenTabs() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_TABS_KEY)) || { ids: [], activeDocId: null };
  } catch {
    return { ids: [], activeDocId: null };
  }
}

function scheduleSave(tab) {
  if (!tab) return;
  tab.pendingHtml = tab.editor.innerHTML;
  // Survive a crash even before the network call goes out.
  if (tab.docId) {
    Backend.stashPending(tab.docId, {
      title: Backend.titleFrom(tab.pendingHtml),
      content: tab.pendingHtml,
    });
  }
  clearTimeout(tab.saveTimer);
  tab.saveTimer = setTimeout(() => saveTab(tab), SAVE_DEBOUNCE_MS);
  rememberOpenTabs();
}

async function saveTab(tab) {
  clearTimeout(tab.saveTimer);
  const html = tab.editor.innerHTML;
  if (html === tab.savedHtml) return;

  // An untouched blank tab should not litter the library.
  if (!tab.docId && !Backend.plainText(html)) return;

  // A document titles itself from its first line — unless it was renamed
  // by hand in the library, in which case that name is left alone.
  const title = tab.titleManual ? tab.title : Backend.titleFrom(html);
  tab.saving = true;
  setSyncStatus('saving');
  try {
    if (tab.docId) {
      await Backend.updateDocument(tab.docId, { title, content: html });
    } else {
      const row = await Backend.createDocument({ title, content: html });
      tab.docId = row.id;
    }
    tab.savedHtml = html;
    tab.title = title;
    Backend.clearPending(tab.docId);
    updateTabChrome(tab);
    rememberOpenTabs();
    setSyncStatus('saved');
    setTimeout(() => { if (syncStatus === 'saved') setSyncStatus('idle'); }, 1600);
  } catch (err) {
    // The text is already in localStorage; retry when we're back online.
    setSyncStatus(navigator.onLine ? 'offline' : 'offline');
    console.warn('save failed, kept locally:', err.message);
  } finally {
    tab.saving = false;
  }
}

// Push every dirty tab now — used before signing out or closing.
async function flushAll() {
  await Promise.all(state.tabs.filter((t) => isDirty(t)).map((t) => saveTab(t)));
}

// Anything stranded by an earlier failure gets another chance.
async function retryPending() {
  if (!navigator.onLine) return;
  const pending = Backend.readPending();
  for (const [docId, payload] of Object.entries(pending)) {
    try {
      await Backend.updateDocument(docId, { title: payload.title, content: payload.content });
      Backend.clearPending(docId);
    } catch { /* still unreachable — leave it queued */ }
  }
  if (Object.keys(pending).length && syncStatus === 'offline') setSyncStatus('idle');
}

window.addEventListener('resize', updateStatus);
window.addEventListener('online', retryPending);
setInterval(retryPending, 30000);

// Best-effort flush when the tab goes away.
window.addEventListener('pagehide', () => {
  for (const tab of state.tabs) {
    if (isDirty(tab) && tab.docId) {
      Backend.stashPending(tab.docId, {
        title: Backend.titleFrom(tab.editor.innerHTML),
        content: tab.editor.innerHTML,
      });
    }
  }
  rememberOpenTabs();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});

/* ---------------- Bringing older writing along ----------------
   Before accounts, documents lived in this browser's localStorage. Any
   text still sitting there belongs to whoever is signing in on this
   machine, so lift it into the account once and leave a marker so it is
   never imported twice.                                              */

// v2 superseded v1 but never deleted it, so both keys can hold the same
// writing. Read the newest one that has anything in it, never both.
const LEGACY_KEYS = ['writers-notepad-session-v2', 'writers-notepad-session-v1'];
const IMPORTED_FLAG = 'machado-imported-local-v1';

function readLegacyDrafts() {
  const drafts = [];
  const seen = new Set();
  for (const key of LEGACY_KEYS) {
    if (drafts.length) break;              // a newer key already supplied them
    let data;
    try {
      data = JSON.parse(localStorage.getItem(key));
    } catch {
      continue;
    }
    if (!data || !Array.isArray(data.tabs)) continue;
    const isPlainText = key.endsWith('v1');
    for (const t of data.tabs) {
      const raw = t.content || '';
      const html = isPlainText ? textToHtml(raw) : raw;
      const text = Backend.plainText(html);
      if (!text) continue;                     // skip empty drafts
      if (seen.has(text)) continue;            // the same draft in two tabs
      seen.add(text);
      drafts.push(html);
    }
  }
  return drafts;
}

async function importLegacyDrafts() {
  if (localStorage.getItem(IMPORTED_FLAG)) return 0;
  const drafts = readLegacyDrafts();
  if (!drafts.length) {
    localStorage.setItem(IMPORTED_FLAG, 'none');
    return 0;
  }
  let imported = 0;
  for (const html of drafts) {
    try {
      await Backend.createDocument({ title: Backend.titleFrom(html), content: html });
      imported++;
    } catch {
      /* leave the flag unset so the next load tries again */
      return imported;
    }
  }
  localStorage.setItem(IMPORTED_FLAG, String(Date.now()));
  return imported;
}

/* ---------------- Preferences ---------------- */

let prefsTimer = null;

function schedulePrefsSave() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    Backend.savePreferences({
      font: state.font,
      theme: state.theme,
      zoom: state.zoom,
      align: state.align,
      column_width: state.columnWidth,
    }).catch(() => { /* preferences are not worth interrupting writing for */ });
  }, 600);
}

/* ---------------- Command dispatch ---------------- */

function doCommand(name, arg) {
  const commands = {
    newTab: () => activateTab(createTab().id),
    closeTab: () => closeTab(state.activeId),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    library: cmdLibrary,
    exportTxt: () => cmdExport('txt'),
    exportHtml: () => cmdExport('html'),
    print: cmdPrint,
    signOut: cmdSignOut,
    undo: editCommands.undo,
    redo: editCommands.redo,
    cut: editCommands.cut,
    copy: editCommands.copy,
    paste: editCommands.paste,
    selectAll: editCommands.selectAll,
    bold: editCommands.bold,
    italic: editCommands.italic,
    underline: editCommands.underline,
    strikethrough: editCommands.strikethrough,
    find: () => find.open(),
    goToLine: () => goTo.open(),
    zoomIn: () => setZoom(state.zoom + ZOOM_STEP),
    zoomOut: () => setZoom(state.zoom - ZOOM_STEP),
    zoomReset: () => setZoom(100),
    setFont: () => setFont(arg),
    setAlign: () => setAlign(arg),
    setColumnWidth: () => setColumnWidth(arg),
    renameEntry: () => beginRename(activeTab()),
    setTheme: () => setTheme(arg),
  };
  commands[name]?.();
}

/* ---------------- Prototype menu bar (native in Phase 2) ---------------- */

function menuDefinition() {
  return [
    {
      label: 'File',
      items: [
        { label: 'New Entry', cmd: 'newTab', key: '⌘T' },
        { sep: true },
        { label: 'Rename Entry…', cmd: 'renameEntry' },
        {
          label: 'Export',
          submenu: [
            { label: 'Plain Text (.txt)', cmd: 'exportTxt' },
            { label: 'HTML (keeps formatting)', cmd: 'exportHtml' },
          ],
        },
        { sep: true },
        { label: 'Print…', cmd: 'print', key: '⌘P' },
        { sep: true },
        {
          label: 'Theme',
          submenu: [
            { label: 'Light', cmd: 'setTheme', arg: 'light', checked: state.theme === 'light' },
            { label: 'Dark', cmd: 'setTheme', arg: 'dark', checked: state.theme === 'dark' },
          ],
        },
        { sep: true },
        { label: 'Close Entry', cmd: 'closeTab', key: '⌘W' },
        { sep: true },
        { label: 'Sign Out', cmd: 'signOut' },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', cmd: 'undo', key: '⌘Z' },
        { label: 'Redo', cmd: 'redo', key: '⇧⌘Z' },
        { sep: true },
        { label: 'Cut', cmd: 'cut', key: '⌘X' },
        { label: 'Copy', cmd: 'copy', key: '⌘C' },
        { label: 'Paste', cmd: 'paste', key: '⌘V' },
        { label: 'Select All', cmd: 'selectAll', key: '⌘A' },
        { sep: true },
        { label: 'Find…', cmd: 'find', key: '⌘F' },
        { label: 'Go to Line…', cmd: 'goToLine', key: '⌘L' },
        { sep: true },
        {
          label: 'Alignment',
          submenu: [
            { label: 'Left', cmd: 'setAlign', arg: 'left', checked: state.align === 'left' },
            { label: 'Right', cmd: 'setAlign', arg: 'right', checked: state.align === 'right' },
            { label: 'Justify', cmd: 'setAlign', arg: 'justify', checked: state.align === 'justify' },
          ],
        },
        {
          label: 'Column Width',
          submenu: COLUMN_WIDTHS.map((w) => ({
            label: w,
            cmd: 'setColumnWidth',
            arg: w,
            checked: state.columnWidth === w,
          })),
        },
      ],
    },
    {
      label: 'Typeface',
      items: FONTS.map((f) => ({
        label: f.name,
        cmd: 'setFont',
        arg: f.name,
        checked: state.font === f.name,
      })),
    },
    {
      label: 'Format',
      items: [
        { label: 'Bold', cmd: 'bold', key: '⌘B' },
        { label: 'Italic', cmd: 'italic', key: '⌘I' },
        { label: 'Underline', cmd: 'underline', key: '⌘U' },
        { label: 'Strikethrough', cmd: 'strikethrough', key: '⇧⌘X' },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', cmd: 'zoomIn', key: '⌘=' },
        { label: 'Zoom Out', cmd: 'zoomOut', key: '⌘−' },
        { label: 'Actual Size', cmd: 'zoomReset', key: '⌘0' },
      ],
    },
  ];
}

// Eduardo's drawing — an open book.
// Source of truth: prototype/open-book.svg
const LIBRARY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"' +
  ' stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M12 6.5C10 5 6.5 4.5 3 5v13.5c3.5-.5 7 0 9 1.5"/>' +
  '<path d="M12 6.5c2-1.5 5.5-2 9-1.5v13.5c-3.5-.5-7 0-9 1.5"/>' +
  '<path d="M12 6.5V20"/>' +
  '</svg>';

function renderMenus() {
  const bar = $('#menubar');
  bar.innerHTML = '';

  // The library sits to the left of the menus, as its own destination
  // rather than an item buried in File.
  const library = document.createElement('button');
  library.type = 'button';
  library.className = 'menubar-icon';
  library.innerHTML = LIBRARY_ICON;
  library.title = `Library (${shortcutLabel('⌘O')})`;
  library.setAttribute('aria-label', 'Library');
  library.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    doCommand('library');
  });
  bar.appendChild(library);
  for (const menu of menuDefinition()) {
    const wrap = document.createElement('div');
    wrap.className = 'menu';
    const btn = document.createElement('button');
    btn.textContent = menu.label;
    wrap.appendChild(btn);
    const list = document.createElement('ul');
    list.className = 'menu-list';
    for (const item of menu.items) {
      if (item.sep) {
        const sep = document.createElement('li');
        sep.className = 'menu-sep';
        list.appendChild(sep);
        continue;
      }
      const li = document.createElement('li');
      li.className = 'menu-item';
      if (item.submenu) {
        li.classList.add('has-sub');
        li.innerHTML = `<span><span class="check"></span>${item.label}</span><span class="sub-arrow">▸</span>`;
        const sub = document.createElement('ul');
        sub.className = 'menu-sub';
        for (const child of item.submenu) {
          const childLi = document.createElement('li');
          childLi.className = 'menu-item';
          childLi.innerHTML = `<span><span class="check">${child.checked ? '✓' : ''}</span>${child.label}</span>`;
          childLi.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllMenus();
            doCommand(child.cmd, child.arg);
          });
          sub.appendChild(childLi);
        }
        li.appendChild(sub);
      } else {
        li.innerHTML = `<span><span class="check">${item.checked ? '✓' : ''}</span>${item.label}</span>` +
          (item.key ? `<span class="shortcut">${shortcutLabel(item.key)}</span>` : '');
        li.addEventListener('click', () => {
          closeAllMenus();
          doCommand(item.cmd, item.arg);
        });
      }
      list.appendChild(li);
    }
    wrap.appendChild(list);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wrap.classList.contains('open');
      closeAllMenus();
      if (!wasOpen) wrap.classList.add('open');
    });
    btn.addEventListener('mouseenter', () => {
      if (bar.querySelector('.menu.open') && !wrap.classList.contains('open')) {
        closeAllMenus();
        wrap.classList.add('open');
      }
    });
    bar.appendChild(wrap);
  }
}

function closeAllMenus() {
  document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
}

document.addEventListener('click', closeAllMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllMenus();
});

/* ---------------- Keyboard shortcuts ---------------- */

document.addEventListener('keydown', (e) => {
  // Find / go-to bar keys
  if (!$('#findbar').hidden && e.target === $('#find-input')) {
    if (e.key === 'Enter') { e.preventDefault(); find.go(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); find.close(); return; }
  }
  if (!$('#gotobar').hidden && e.target === $('#goto-input')) {
    if (e.key === 'Enter') { e.preventDefault(); goTo.go(); return; }
    if (e.key === 'Escape') { e.preventDefault(); goTo.close(); return; }
  }
  if (e.key === 'Escape') {
    if (find.active) { find.close(); return; }
    if (!$('#gotobar').hidden) { goTo.close(); return; }
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  const key = e.key.toLowerCase();
  const map = {
    t: 'newTab',
    w: 'closeTab',            // browsers may reserve ⌘W/⌘T; native in Phase 2
    o: 'library',
    p: 'print',
    f: 'find',
    l: 'goToLine',
    b: 'bold',
    i: 'italic',
    u: 'underline',
    '=': 'zoomIn',
    '+': 'zoomIn',
    '-': 'zoomOut',
    '0': 'zoomReset',
  };

  let cmd = null;
  // Everything autosaves, so swallow the browser's Save-page dialog and
  // just flush instead — muscle memory still gets what it wants.
  if (key === 's') { e.preventDefault(); flushAll(); return; }
  else if (key === 'e' && e.shiftKey) cmd = 'exportHtml';
  else if (key === 'e') cmd = 'exportTxt';
  else if (key === 'x' && e.shiftKey) cmd = 'strikethrough';
  else if (key === ']' && e.shiftKey) cmd = 'nextTab';
  else if (key === '[' && e.shiftKey) cmd = 'prevTab';
  else if (e.ctrlKey && key === 'tab') cmd = e.shiftKey ? 'prevTab' : 'nextTab';
  else if (!e.shiftKey && map[key]) cmd = map[key];

  if (cmd) {
    e.preventDefault();
    doCommand(cmd);
  }
});

/* ---------------- Boot ---------------- */

$('#tab-add').addEventListener('click', () => doCommand('newTab'));
$('#find-input').addEventListener('input', () => { find.current = -1; find.refresh(); });
$('#find-prev').addEventListener('click', () => find.go(-1));
$('#find-next').addEventListener('click', () => find.go(1));
$('#find-close').addEventListener('click', () => find.close());
$('#goto-close').addEventListener('click', () => goTo.close());

// Formatting should produce <b>/<i>/<u> tags, not styled spans
try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }

// Open the document named in ?doc=, or a specific new one for ?new=1,
// then fall back to whatever this device had open last.
async function restoreWorkspace() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('doc');
  const forceNew = params.get('new');
  // Keep the address bar clean; the state now lives in the app.
  if (wanted || forceNew) {
    history.replaceState({}, '', location.pathname);
  }

  if (forceNew) {
    activateTab(createTab().id);
    return;
  }

  const { ids, activeDocId } = readOpenTabs();
  const toOpen = wanted ? [wanted, ...ids.filter((id) => id !== wanted)] : ids;

  let opened = 0;
  for (const id of toOpen.slice(0, 12)) {
    try {
      const doc = await Backend.getDocument(id);
      // A newer local copy means the last session ended before its save did.
      const pending = Backend.getPending(doc.id);
      const content = pending && pending.ts > Date.parse(doc.updated_at)
        ? pending.content
        : doc.content;
      const tab = createTab({
        docId: doc.id,
        title: doc.title,
        content,
        titleManual: !!doc.title_manual,
      });
      if (pending && content !== doc.content) {
        tab.savedHtml = doc.content;   // still needs pushing
        scheduleSave(tab);
      }
      opened++;
    } catch {
      /* deleted elsewhere, or not ours — skip it */
    }
  }

  if (!opened) {
    activateTab(createTab().id);
    return;
  }
  const focus =
    state.tabs.find((t) => t.docId === (wanted || activeDocId)) || state.tabs[0];
  activateTab(focus.id);
}

(async () => {
  if (!(await Backend.requireAuth())) return;

  // Preferences follow the account; the system decides only on first run.
  try {
    const prefs = await Backend.loadPreferences();
    if (prefs) {
      state.font = prefs.font || DEFAULT_FONT;
      state.zoom = prefs.zoom || 100;
      state.align = prefs.align || 'left';
      state.columnWidth = prefs.column_width || DEFAULT_COLUMN;
      state.theme = prefs.theme || null;
    }
  } catch { /* offline — fall back to defaults */ }

  setTheme(state.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  setFont(state.font);
  setZoom(state.zoom);
  setAlign(state.align);
  setColumnWidth(state.columnWidth);
  renderMenus();

  try {
    const brought = await importLegacyDrafts();
    if (brought) {
      setSyncStatus('saved');
      console.info(`Brought ${brought} local draft(s) into your account.`);
    }
  } catch { /* not worth blocking the editor over */ }

  await restoreWorkspace();
  updateStatus();
  retryPending();
  document.body.classList.remove('booting');
})();

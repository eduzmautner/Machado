/* ------------------------------------------------------------------
   Writer's Notepad — prototype logic
   Rich-text editor (contenteditable) with tabs. File open/save/print
   go through `platform` so Phase 2 (Electron) swaps in IPC without
   touching the rest.
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

const DEFAULT_FONT = 'Georgia';
const BASE_FONT_PX = 17;
const ZOOM_MIN = 50, ZOOM_MAX = 200, ZOOM_STEP = 10;
const SESSION_KEY = 'writers-notepad-session-v2';
const LEGACY_SESSION_KEY = 'writers-notepad-session-v1';

const formatFor = (name) => (/\.html?$/i.test(name || '') ? 'html' : 'txt');

/* ---------------- Text <-> HTML helpers ---------------- */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain text -> one <div> per line (the contenteditable line model)
function textToHtml(text) {
  return text
    .split('\n')
    .map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`)
    .join('');
}

const BLOCK_RE = /^(DIV|P)$/;

// Walk an element's contents producing plain text (one \n per line) and,
// optionally, the list of text nodes with their offsets into that text.
// Every consumer (status bar, find, go-to-line, save-as-txt) uses this
// walker so offsets always agree.
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

/* ---------------- Platform adapter (browser flavor) ---------------- */

const FILE_TYPES_OPEN = [
  {
    description: 'Documents',
    accept: { 'text/plain': ['.txt', '.md', '.text'], 'text/html': ['.html', '.htm'] },
  },
];

const platform = {
  supportsFilePicker: 'showOpenFilePicker' in window,

  // -> { name, content, handle } | null (cancelled)
  async openFile() {
    if (this.supportsFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ types: FILE_TYPES_OPEN });
        const file = await handle.getFile();
        return { name: file.name, content: await file.text(), handle };
      } catch (err) {
        if (err.name === 'AbortError') return null;
        throw err;
      }
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.md,.text,.html,.htm,text/plain,text/html';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return resolve(null);
        resolve({ name: file.name, content: await file.text(), handle: null });
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  async saveFile(handle, content) {
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  },

  // Ask where to save; the picker's format dropdown offers .txt and .html.
  // Returns { name, handle } (handle null in the download fallback) | null.
  async pickSaveFile(suggestedName, preferHtml) {
    const txtType = { description: 'Plain Text', accept: { 'text/plain': ['.txt'] } };
    const htmlType = { description: 'HTML (keeps formatting)', accept: { 'text/html': ['.html', '.htm'] } };
    if (this.supportsFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: preferHtml ? [htmlType, txtType] : [txtType, htmlType],
        });
        return { name: handle.name, handle };
      } catch (err) {
        if (err.name === 'AbortError') return null;
        throw err;
      }
    }
    return { name: suggestedName, handle: null }; // caller downloads a blob
  },

  download(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  print(html, fontStack, align) {
    const root = $('#print-root');
    root.innerHTML = html;
    root.style.fontFamily = fontStack;
    root.style.textAlign = align;
    window.print();
  },
};

/* ---------------- State ---------------- */

const state = {
  tabs: [],          // Tab objects, in strip order
  activeId: null,
  font: DEFAULT_FONT,
  zoom: 100,
  align: 'left',     // 'left' | 'right' | 'justify'
  theme: null,       // 'light' | 'dark'; resolved from system on first launch
  untitledCounter: 1,
};

let tabIdCounter = 1;

/* ---------------- Tabs ---------------- */

function createTab({ title = null, fileName = null, content = '', savedContent = '', handle = null } = {}) {
  const id = tabIdCounter++;
  const tab = {
    id,
    fileName,                                        // basename of the backing file, if any
    title: title || fileName || `Untitled ${state.untitledCounter === 1 ? '' : state.untitledCounter}`.trim(),
    handle,                                          // FileSystemFileHandle (lost across reloads)
    format: formatFor(fileName),                     // 'txt' | 'html' — how Save serializes
    savedHtml: '',                                   // innerHTML as of last save; dirty = differs
    el: null, editor: null,
  };
  if (!fileName && !title) state.untitledCounter++;

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
  tab.savedHtml = savedContent === content ? editor.innerHTML : savedContent;
  editor.addEventListener('input', () => {
    updateTabChrome(tab);
    updateStatus();
    if (find.active) find.refresh();
    scheduleSessionSave();
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
  scheduleSessionSave();
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = state.tabs.splice(idx, 1);
  tab.el.remove();
  tab.docEl.remove();
  if (state.tabs.length === 0) {
    const fresh = createTab();
    activateTab(fresh.id);
  } else if (state.activeId === id) {
    activateTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
  } else {
    scheduleSessionSave();
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
  tab.el.querySelector('.tab-title').textContent = tab.title;
  tab.el.title = tab.fileName || tab.title;
  if (tab.id === state.activeId) document.title = tab.title + (dirty ? ' •' : '');
}

// A tab that's empty, untouched, and not tied to a file — reuse it for Open
function isBlankTab(tab) {
  return tab && !tab.fileName && tab.editor.textContent === '' && tab.savedHtml === '';
}

/* ---------------- File commands ---------------- */

const hasFormatting = (tab) => /<(b|i|u|s|strong|em|strike|del)\b/i.test(tab.editor.innerHTML);

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

function serialize(tab) {
  return tab.format === 'html' ? htmlDoc(tab) : plainTextOf(tab.editor);
}

async function cmdOpen() {
  const result = await platform.openFile();
  if (!result) return;
  let tab = activeTab();
  if (!isBlankTab(tab)) tab = createTab();
  tab.fileName = result.name;
  tab.title = result.name;
  tab.handle = result.handle;
  tab.format = formatFor(result.name);
  if (tab.format === 'html') {
    const doc = new DOMParser().parseFromString(result.content, 'text/html');
    tab.editor.innerHTML = sanitizeHtml(doc.body.innerHTML);
  } else {
    tab.editor.innerHTML = textToHtml(result.content);
  }
  tab.savedHtml = tab.editor.innerHTML;
  activateTab(tab.id);
  updateTabChrome(tab);
}

async function cmdSave() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.handle) {
    await platform.saveFile(tab.handle, serialize(tab));
    tab.savedHtml = tab.editor.innerHTML;
    updateTabChrome(tab);
  } else {
    await cmdSaveAs();
  }
}

async function cmdSaveAs() {
  const tab = activeTab();
  if (!tab) return;
  const preferHtml = tab.format === 'html' || (!tab.fileName && hasFormatting(tab));
  const base = (tab.fileName || tab.title).replace(/\.(txt|md|text|html|htm)$/i, '');
  const suggested = base + (preferHtml ? '.html' : '.txt');
  const result = await platform.pickSaveFile(suggested, preferHtml);
  if (!result) return;
  tab.fileName = result.name;
  tab.title = result.name;
  tab.handle = result.handle;
  tab.format = formatFor(result.name);
  const content = serialize(tab);
  if (result.handle) {
    await platform.saveFile(result.handle, content);
  } else {
    platform.download(result.name, content, tab.format === 'html' ? 'text/html' : 'text/plain');
  }
  tab.savedHtml = tab.editor.innerHTML;
  updateTabChrome(tab);
  scheduleSessionSave();
}

function cmdPrint() {
  const tab = activeTab();
  if (!tab) return;
  platform.print(tab.editor.innerHTML, currentFontStack(), state.align);
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
    if (tab) input.max = plainTextOf(tab.editor).split('\n').length;
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
    const { text, parts } = collectText(tab.editor);
    const lines = text.replace(/\n$/, '').split('\n');
    const n = Math.max(1, Math.min(parseInt($('#goto-input').value, 10) || 1, lines.length));
    let offset = 0;
    for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
    // Find the text node at (or first after) the target offset
    let target = parts.find((p) => offset >= p.start && offset <= p.start + p.node.nodeValue.length);
    if (!target) target = parts.find((p) => p.start >= offset) || parts[parts.length - 1];
    this.close();
    if (!target) return;
    const r = document.createRange();
    const off = Math.max(0, Math.min(offset - target.start, target.node.nodeValue.length));
    r.setStart(target.node, off);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const rect = r.getBoundingClientRect();
    const er = tab.editor.getBoundingClientRect();
    tab.editor.scrollTop += rect.top - er.top - tab.editor.clientHeight / 3;
    updateStatus();
  },
};

/* ---------------- Zoom, font, alignment, theme ---------------- */

function setZoom(zoom) {
  state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  $('#editor').style.fontSize = (BASE_FONT_PX * state.zoom) / 100 + 'px';
  const el = $('#status-zoom');
  el.hidden = state.zoom === 100;
  el.textContent = state.zoom + '%';
  scheduleSessionSave();
}

function currentFontStack() {
  return (FONTS.find((f) => f.name === state.font) || FONTS[0]).stack;
}

function setFont(name) {
  const resolved = FONT_ALIASES[name] || name;
  state.font = FONTS.some((f) => f.name === resolved) ? resolved : DEFAULT_FONT;
  $('#editor').style.fontFamily = currentFontStack();
  renderMenus();
  scheduleSessionSave();
}

function setAlign(name) {
  state.align = ['left', 'right', 'justify'].includes(name) ? name : 'left';
  $('#editor').style.textAlign = state.align;
  renderMenus();
  scheduleSessionSave();
}

function setTheme(name) {
  state.theme = name === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  renderMenus();
  scheduleSessionSave();
}

/* ---------------- Status bar ---------------- */

// Plain text from the editor start up to the caret (for the Ln readout)
function caretPreText(editor) {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(editor);
  pre.setEnd(range.endContainer, range.endOffset);
  const div = document.createElement('div');
  div.appendChild(pre.cloneContents());
  return collectText(div).text;
}

function updateStatus() {
  const tab = activeTab();
  if (!tab) return;
  const text = plainTextOf(tab.editor);
  const pre = caretPreText(tab.editor);
  let line = 1;
  if (pre !== null) {
    line = (pre.replace(/\n$/, '').match(/\n/g) || []).length + 1;
  }
  $('#status-pos').textContent = `Ln ${line}`;
  const words = (text.match(/\S+/g) || []).length;
  $('#status-words').textContent =
    words.toLocaleString() + (words === 1 ? ' word' : ' words');
  $('#status-count').textContent =
    text.length.toLocaleString() + (text.length === 1 ? ' character' : ' characters');
}

/* ---------------- Session persistence (silent restore) ---------------- */

let sessionTimer = null;

function scheduleSessionSave() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 300);
}

function saveSession() {
  const data = {
    tabs: state.tabs.map((t) => ({
      title: t.title,
      fileName: t.fileName,
      content: t.editor.innerHTML,
      savedContent: t.savedHtml,
    })),
    activeIndex: state.tabs.findIndex((t) => t.id === state.activeId),
    font: state.font,
    zoom: state.zoom,
    align: state.align,
    theme: state.theme,
    untitledCounter: state.untitledCounter,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch { /* storage full/unavailable — silently skip */ }
}

function restoreSession() {
  let data = null;
  let legacy = false;
  try {
    data = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!data) {
      // v1 sessions stored plain text; convert to the rich-text model
      data = JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY));
      legacy = true;
    }
  } catch { /* corrupted — start fresh */ }
  if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return false;
  state.font = data.font || DEFAULT_FONT;
  state.zoom = data.zoom || 100;
  state.align = data.align || 'left';
  state.theme = data.theme || null;
  state.untitledCounter = data.untitledCounter || 1;
  for (const t of data.tabs) {
    createTab({
      title: t.title,
      fileName: t.fileName,
      content: legacy ? textToHtml(t.content || '') : t.content || '',
      savedContent: legacy ? textToHtml(t.savedContent ?? '') : t.savedContent ?? '',
      handle: null, // file handles don't survive reload; Save falls back to Save As
    });
  }
  const idx = Math.max(0, Math.min(data.activeIndex ?? 0, state.tabs.length - 1));
  activateTab(state.tabs[idx].id);
  return true;
}

window.addEventListener('beforeunload', saveSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});

/* ---------------- Command dispatch ---------------- */

function doCommand(name, arg) {
  const commands = {
    newTab: () => activateTab(createTab().id),
    closeTab: () => closeTab(state.activeId),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    open: cmdOpen,
    save: cmdSave,
    saveAs: cmdSaveAs,
    print: cmdPrint,
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
        { label: 'New Tab', cmd: 'newTab', key: '⌘T' },
        { label: 'Open…', cmd: 'open', key: '⌘O' },
        { sep: true },
        { label: 'Save', cmd: 'save', key: '⌘S' },
        { label: 'Save As…', cmd: 'saveAs', key: '⇧⌘S' },
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
        { label: 'Close Tab', cmd: 'closeTab', key: '⌘W' },
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

function renderMenus() {
  const bar = $('#menubar');
  bar.innerHTML = '';
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
    o: 'open',
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
  if (key === 's') cmd = e.shiftKey ? 'saveAs' : 'save';
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

if (!restoreSession()) {
  activateTab(createTab().id);
}
// First launch: theme follows the system; after that, the user's pick sticks
setTheme(state.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
setFont(state.font);
setZoom(state.zoom);
setAlign(state.align);
renderMenus();
updateStatus();

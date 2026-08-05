// Writer's Notepad — Electron main process.
// Owns the window, the native macOS menu bar, file dialogs/IO, and the
// session file. All document logic lives in the renderer.

'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.json');

let win = null;

// Menu radio state, kept in sync with the renderer via 'state:sync'
let menuState = { font: 'Georgia', align: 'left', theme: null };

const FONT_NAMES = [
  'Georgia',
  'Times New Roman',
  'Palatino',
  'Helvetica',
  'Avenir',
  'Courier New',
  'Iowan Old Style',
];

const cmd = (name, arg) => () => win && win.webContents.send('command', name, arg);

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: cmd('newTab') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: cmd('saveAs') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd('print') },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'Light', type: 'radio', checked: menuState.theme === 'light', click: cmd('setTheme', 'light') },
            { label: 'Dark', type: 'radio', checked: menuState.theme === 'dark', click: cmd('setTheme', 'dark') },
          ],
        },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('closeTab') },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
        { label: 'Go to Line…', accelerator: 'CmdOrCtrl+L', click: cmd('goToLine') },
        { type: 'separator' },
        {
          label: 'Alignment',
          submenu: [
            { label: 'Left', type: 'radio', checked: menuState.align === 'left', click: cmd('setAlign', 'left') },
            { label: 'Right', type: 'radio', checked: menuState.align === 'right', click: cmd('setAlign', 'right') },
            { label: 'Justify', type: 'radio', checked: menuState.align === 'justify', click: cmd('setAlign', 'justify') },
          ],
        },
      ],
    },
    {
      label: 'Typeface',
      submenu: FONT_NAMES.map((name) => ({
        label: name,
        type: 'radio',
        checked: menuState.font === name,
        click: cmd('setFont', name),
      })),
    },
    {
      label: 'Format',
      submenu: [
        { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: cmd('bold') },
        { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: cmd('italic') },
        { label: 'Underline', accelerator: 'CmdOrCtrl+U', click: cmd('underline') },
        { label: 'Strikethrough', accelerator: 'Shift+CmdOrCtrl+X', click: cmd('strikethrough') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoomOut') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoomReset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: 'Shift+CmdOrCtrl+]', click: cmd('nextTab') },
        { label: 'Show Previous Tab', accelerator: 'Shift+CmdOrCtrl+[', click: cmd('prevTab') },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    { role: 'help', submenu: [] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1E1E1E' : '#F9F8F6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });

  // Headless smoke-test hook (dev only): CAPTURE_PATH=/tmp/x.png npm start
  if (process.env.CAPTURE_PATH) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          await fs.writeFile(process.env.CAPTURE_PATH, img.toPNG());
        } finally {
          app.quit();
        }
      }, 1200);
    });
  }
}

/* ---------------- IPC: files, session, menu state ---------------- */

const FILTERS_OPEN = [
  { name: 'Documents', extensions: ['txt', 'md', 'text', 'html', 'htm'] },
  { name: 'All Files', extensions: ['*'] },
];

ipcMain.handle('file:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: FILTERS_OPEN,
  });
  if (canceled || !filePaths.length) return null;
  const p = filePaths[0];
  const content = await fs.readFile(p, 'utf8');
  return { name: path.basename(p), path: p, content };
});

ipcMain.handle('file:save', async (_e, filePath, content) => {
  await fs.writeFile(filePath, content, 'utf8');
  return true;
});

ipcMain.handle('file:pickSave', async (_e, suggestedName, preferHtml) => {
  const html = { name: 'HTML (keeps formatting)', extensions: ['html', 'htm'] };
  const txt = { name: 'Plain Text', extensions: ['txt'] };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: preferHtml ? [html, txt] : [txt, html],
  });
  if (canceled || !filePath) return null;
  return { name: path.basename(filePath), path: filePath };
});

ipcMain.handle('session:load', async () => {
  try {
    return JSON.parse(await fs.readFile(SESSION_FILE(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.on('session:save', (_e, data) => {
  fs.writeFile(SESSION_FILE(), JSON.stringify(data)).catch(() => {});
});

ipcMain.on('state:sync', (_e, s) => {
  menuState = { ...menuState, ...s };
  if (s.theme) nativeTheme.themeSource = s.theme;
  buildMenu();
});

/* ---------------- App lifecycle ---------------- */

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention: stay in the dock; reopen via Cmd+Tab / dock click
  if (process.platform !== 'darwin') app.quit();
});

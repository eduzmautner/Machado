// Renders build/icon.html's canvas to build/icon-1024.png.
// Run with: npx electron build/gen-icon.js  (from app/)

'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 100, height: 100 });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  const dataUrl = await win.webContents.executeJavaScript('drawIcon()');
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(__dirname, 'icon-1024.png'), png);
  console.log('wrote icon-1024.png (' + png.length + ' bytes)');
  app.quit();
});

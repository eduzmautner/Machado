# Machado.

A free, no-nonsense writing app for spontaneous ideas, or thoroughly calculated ones. Named after Machado de Assis.

- Just enough tools to get you writing. No distractions.
- Tabs for multiple documents, rich text (bold/italic/underline/strikethrough), find, word wrap that keeps lines readable.
- Your session restores silently — close it, reopen it, keep writing.
- Fully offline.

## Try it in the browser

The `prototype/` folder is the browser version — open it on GitHub Pages, or run it locally:

```bash
node serve.js            # serves prototype/ at http://localhost:5173
```

## The Mac app

`app/` is the native macOS app (Electron): native menu bar, real file open/save (.txt or .html with formatting), print, and its own icon.

```bash
cd app
npm install
npm start                # dev run
npm run dist             # package .dmg / .zip into app/dist
```

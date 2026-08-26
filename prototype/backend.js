/* ------------------------------------------------------------------
   Machado — everything that talks to the server.

   The anon key below is meant to be public: it identifies the project,
   it does not grant access. Every table has Row Level Security, so the
   database itself refuses to return another user's rows no matter what
   this file asks for. See supabase/schema.sql.
------------------------------------------------------------------- */

'use strict';

const SUPABASE_URL = 'https://tkxwrjwhfyyjjrhuwzqx.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRreHdyandoZnl5ampyaHV3enF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MDk2MjcsImV4cCI6MjEwMzA4NTYyN30.HjOLLw7ShDOU9j7yxZW8ed8ACtlsNsqSlih6dD4OEuo';

const Backend = (() => {
  const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // Pages are siblings, so resolve against the current directory.
  const pageUrl = (page) => new URL(page, location.href).href;

  /* ---------------- Auth ---------------- */

  async function session() {
    const { data } = await client.auth.getSession();
    return data.session || null;
  }

  // Guard for pages that need a signed-in user. Returns the session, or
  // redirects to the login page and resolves to null.
  async function requireAuth() {
    const s = await session();
    if (!s) {
      location.replace(pageUrl('login.html'));
      return null;
    }
    return s;
  }

  const signIn = (email, password) =>
    client.auth.signInWithPassword({ email, password });

  const signUp = (email, password) =>
    client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: pageUrl('index.html') },
    });

  const signInWithGoogle = () =>
    client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: pageUrl('index.html') },
    });

  const signOut = () => client.auth.signOut();

  const onAuthChange = (cb) => client.auth.onAuthStateChange((_e, s) => cb(s));

  /* ---------------- Documents ---------------- */

  // Newest-first, without dragging every document's full text over the
  // wire — the library only needs enough for a preview.
  async function listDocuments() {
    const { data, error } = await client
      .from('documents')
      .select('id, title, content, created_at, updated_at, title_manual')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async function getDocument(id) {
    const { data, error } = await client
      .from('documents')
      .select('id, title, content, created_at, updated_at, title_manual')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  }

  async function createDocument({ title, content }) {
    const s = await session();
    const { data, error } = await client
      .from('documents')
      .insert({ user_id: s.user.id, title, content })
      .select('id, title, content, created_at, updated_at, title_manual')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateDocument(id, { title, content }) {
    const { data, error } = await client
      .from('documents')
      .update({ title, content })
      .eq('id', id)
      .select('id, title, updated_at')
      .single();
    if (error) throw error;
    return data;
  }

  // Renaming pins the title: the editor will stop re-deriving it from the
  // document's first line, so the name you chose survives further writing.
  async function renameDocument(id, title) {
    const { data, error } = await client
      .from('documents')
      .update({ title, title_manual: true })
      .eq('id', id)
      .select('id, title, updated_at, title_manual')
      .single();
    if (error) throw error;
    return data;
  }

  async function deleteDocument(id) {
    const { error } = await client.from('documents').delete().eq('id', id);
    if (error) throw error;
  }

  /* ---------------- Preferences ---------------- */

  async function loadPreferences() {
    const { data, error } = await client
      .from('preferences')
      .select('font, theme, zoom, align, show_excerpts')
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function savePreferences(prefs) {
    const s = await session();
    if (!s) return;
    await client.from('preferences').upsert({ user_id: s.user.id, ...prefs });
  }

  /* ---------------- Offline write buffer ----------------
     Every edit lands in localStorage synchronously before it is sent to
     the server, so closing the laptop mid-sentence or losing wifi never
     costs you text. Entries clear once the server confirms the write. */

  const PENDING_KEY = 'machado-pending-v1';

  const readPending = () => {
    try {
      return JSON.parse(localStorage.getItem(PENDING_KEY)) || {};
    } catch {
      return {};
    }
  };

  const writePending = (map) => {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(map));
    } catch {
      /* storage full — the server copy is still authoritative */
    }
  };

  function stashPending(docId, payload) {
    const map = readPending();
    map[docId] = { ...payload, ts: Date.now() };
    writePending(map);
  }

  function clearPending(docId) {
    const map = readPending();
    delete map[docId];
    writePending(map);
  }

  const getPending = (docId) => readPending()[docId] || null;

  /* ---------------- Misc ---------------- */

  // Plain text from stored HTML, for titles and library previews.
  function plainText(html) {
    const el = document.createElement('div');
    el.innerHTML = html || '';
    // block elements should read as line breaks, not run together
    el.querySelectorAll('div, p, br').forEach((n) => n.before('\n'));
    return (el.textContent || '').replace(/\n{2,}/g, '\n').trim();
  }

  // Documents title themselves from their first line, the way a notebook
  // page is known by its opening words.
  function titleFrom(html) {
    const first = (plainText(html).split('\n').find((l) => l.trim()) || '').trim();
    if (!first) return 'Untitled';
    if (first.length <= 80) return first;
    // Break at a word boundary rather than mid-word.
    const cut = first.slice(0, 80);
    const space = cut.lastIndexOf(' ');
    return (space > 40 ? cut.slice(0, space) : cut).trimEnd() + '…';
  }

  return {
    client,
    pageUrl,
    session, requireAuth, signIn, signUp, signInWithGoogle, signOut, onAuthChange,
    listDocuments, getDocument, createDocument, updateDocument, renameDocument, deleteDocument,
    loadPreferences, savePreferences,
    stashPending, clearPending, getPending, readPending,
    plainText, titleFrom,
  };
})();

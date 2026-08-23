/* ------------------------------------------------------------------
   Machado — sign in / create account.
   Passwords go straight to Supabase Auth over TLS; this page never
   stores or forwards them anywhere else.
------------------------------------------------------------------- */

'use strict';

const $ = (sel) => document.querySelector(sel);

let mode = 'signin'; // 'signin' | 'signup'
let busy = false;

const notice = $('#notice');

function say(message, kind = 'error') {
  notice.textContent = message;
  notice.className = `notice notice-${kind}`;
  notice.hidden = !message;
}

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  $('#submit').textContent = signup ? 'Create account' : 'Sign in';
  $('#switch-text').textContent = signup ? 'Already have an account?' : 'New here?';
  $('#switch-mode').textContent = signup ? 'Sign in' : 'Create an account';
  $('#password').autocomplete = signup ? 'new-password' : 'current-password';
  document.title = `${signup ? 'Create account' : 'Sign in'} · Machado`;
  say('');
}

function setBusy(state, label) {
  busy = state;
  const btn = $('#submit');
  btn.disabled = state;
  $('#google').disabled = state;
  btn.textContent = state ? label : mode === 'signup' ? 'Create account' : 'Sign in';
}

/* ---------------- Email + password ---------------- */

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;

  const email = $('#email').value.trim();
  const password = $('#password').value;

  if (!email || !password) return say('Enter your email and password.');
  if (mode === 'signup' && password.length < 8) {
    return say('Passwords need at least 8 characters.');
  }

  setBusy(true, mode === 'signup' ? 'Creating…' : 'Signing in…');
  try {
    const { data, error } =
      mode === 'signup'
        ? await Backend.signUp(email, password)
        : await Backend.signIn(email, password);

    if (error) return say(friendly(error.message));

    // With email confirmation on, sign-up returns a user but no session.
    if (mode === 'signup' && !data.session) {
      return say(`Almost there — confirm your address from the email we sent to ${email}.`, 'ok');
    }
    location.replace(Backend.pageUrl('index.html'));
  } catch (err) {
    say(friendly(err.message));
  } finally {
    if (busy) setBusy(false);
  }
});

/* ---------------- Google ---------------- */

$('#google').addEventListener('click', async () => {
  if (busy) return;
  say('');
  $('#google').disabled = true;
  const { error } = await Backend.signInWithGoogle();
  if (error) {
    $('#google').disabled = false;
    say(
      /not enabled|unsupported provider/i.test(error.message)
        ? 'Google sign-in is not switched on for this project yet.'
        : friendly(error.message)
    );
  }
  // On success the browser leaves for Google's consent screen.
});

$('#switch-mode').addEventListener('click', () =>
  setMode(mode === 'signup' ? 'signin' : 'signup')
);

// Supabase phrases a few of these for developers rather than for people.
function friendly(message = '') {
  if (/invalid login credentials/i.test(message)) {
    return 'That email and password combination does not match an account.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'Confirm your email address first — check your inbox for the link.';
  }
  if (/already registered/i.test(message)) {
    return 'There is already an account with that email. Try signing in.';
  }
  if (/rate limit|too many/i.test(message)) {
    return 'Too many attempts just now. Wait a minute and try again.';
  }
  if (/failed to fetch|network/i.test(message)) {
    return 'Could not reach the server. Check your connection.';
  }
  return message || 'Something went wrong. Try again.';
}

/* ---------------- Boot ---------------- */

(async () => {
  // Land signed-in visitors straight in the editor, and reveal the form
  // only once we know they need it — no flash of the wrong page.
  if (await Backend.session()) {
    location.replace(Backend.pageUrl('index.html'));
    return;
  }
  $('#panel').hidden = false;
  $('#email').focus();

  // The OAuth round trip resolves the session after this script runs.
  Backend.onAuthChange((s) => {
    if (s) location.replace(Backend.pageUrl('index.html'));
  });
})();

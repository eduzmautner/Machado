/* ------------------------------------------------------------------
   Machado — paint in the right palette from the very first frame.

   The chosen theme lives in your account, but waiting for that round
   trip would flash a light page at someone who works in the dark. So
   the last known choice is mirrored to localStorage and applied here,
   in <head>, before the browser paints anything. The server value
   reconciles a moment later.
------------------------------------------------------------------- */

(function () {
  try {
    var theme = localStorage.getItem('machado-theme');
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* private mode — fall back to the stylesheet's light default */
  }
})();

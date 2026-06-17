/**
 * loading-overlay.js — Reusable full-screen "loading" overlay.
 *
 * Setup (any page):
 *   <link rel="stylesheet" href="/css/loading-overlay.css">
 *   <script src="/js/loading-overlay.js"></script>
 *
 * Usage:
 *   LoadingOverlay.show(2000);                       // show 2s then auto-hide
 *   LoadingOverlay.show(2000, "Loading meter 5");    // custom title text
 *   LoadingOverlay.show();                           // show until hide() is called
 *   LoadingOverlay.hide();                           // hide immediately
 *
 * show() returns a Promise that resolves once the overlay hides — handy if you
 * want to run code right after the fake load finishes:
 *   LoadingOverlay.show(2000).then(() => { ... });
 */
(function (global) {
  "use strict";

  let overlayEl = null;
  let textEl = null;
  let hideTimer = null;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement("div");
    overlayEl.className = "lo-overlay";
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-live", "polite");
    overlayEl.innerHTML =
      '<div class="lo-spinner" aria-hidden="true"></div>' +
      '<div class="lo-text"></div>' +
      '<div class="lo-sub lo-dots">Please wait</div>';

    textEl = overlayEl.querySelector(".lo-text");
    (document.body || document.documentElement).appendChild(overlayEl);
    return overlayEl;
  }

  function hide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (overlayEl) overlayEl.classList.remove("is-visible");
  }

  /**
   * @param {number} [duration] ms to keep the overlay up; <=0 / omitted = manual hide
   * @param {string} [text] title shown above the dots (default "Loading")
   * @returns {Promise<void>} resolves when the overlay hides
   */
  function show(duration, text) {
    ensureOverlay();

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    textEl.textContent = text || "Loading";

    // Force reflow so the fade-in re-runs even on rapid repeated calls.
    void overlayEl.offsetWidth;
    overlayEl.classList.add("is-visible");

    return new Promise((resolve) => {
      if (duration && duration > 0) {
        hideTimer = setTimeout(() => {
          hide();
          resolve();
        }, duration);
      } else {
        resolve();
      }
    });
  }

  global.LoadingOverlay = { show: show, hide: hide };
})(window);

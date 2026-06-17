// Applies the saved menu state (expanded/collapsed) BEFORE the page paints,
// so the sidebar never flashes/animates open->closed when navigating between pages.
// Must be loaded as the first child of <body> (blocking, not deferred).
(function () {
  try {
    var raw = localStorage.getItem("mt_state_v1");
    var mode = "expanded";
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.mode === "collapsed") mode = "collapsed";
    }
    document.body.classList.add(mode === "collapsed" ? "mt-collapsed" : "mt-expanded");
  } catch (e) {
    document.body.classList.add("mt-expanded");
  }
})();

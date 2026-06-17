(function () {
  const root = document.querySelector("[data-header-clock]");
  if (!root) return;

  const timeEl = root.querySelector(".hc-time");
  if (!timeEl) return;

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function tick() {
    const now = new Date();
    timeEl.textContent = formatter.format(now);
    timeEl.title = now.toString();
  }

  tick();
  setInterval(tick, 1000);
})();


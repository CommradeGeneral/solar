(function () {
  const menuEl = document.getElementById("menuTree");
  const backdropEl = document.getElementById("menuTreeBackdrop");
  const openBtnEl = document.getElementById("menuTreeOpenBtn");
  if (!menuEl) return;

  const STORAGE_KEY = "mt_state_v1";

  const state = {
    mode: "expanded", // expanded | collapsed
  };

  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.mode === "expanded" || parsed.mode === "collapsed")) {
        state.mode = parsed.mode;
      }
    } catch {
      // ignore
    }
  }

  function writeState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: state.mode }));
    } catch {
      // ignore
    }
  }

  function isMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
  }

  function applyBodyClasses() {
    document.body.classList.toggle("mt-expanded", state.mode === "expanded");
    document.body.classList.toggle("mt-collapsed", state.mode === "collapsed");
  }

  function setBackdropVisible(visible) {
    if (!backdropEl) return;
    backdropEl.hidden = !visible;
  }

  function closeMobileMenu() {
    document.body.classList.remove("mt-open");
    setBackdropVisible(false);
  }

  function openMobileMenu() {
    document.body.classList.add("mt-open");
    setBackdropVisible(true);
  }

  function toggleMenu() {
    if (isMobile()) {
      if (document.body.classList.contains("mt-open")) closeMobileMenu();
      else openMobileMenu();
      return;
    }

    // Desktop: menu is LOCKED collapsed — never expand.
    return;
  }

  const groups = [
    {
      id: "g_main",
      name: "Main",
      expanded: true,
      items: [
        { href: "http://192.168.1.2:5000/dashboard.html", label: "Home", img: "/static/images/icon/Dashboard.png" },
        { href: "http://192.168.1.2:5000/solar.html", label: "Network", img: "/static/images/icon/network.png" },
        { href: "http://192.168.1.2:5000/Sld.html", label: "MV SWG", img: "/static/images/icon/Sld.png" },
        { href: "http://192.168.1.2:5000/MultiTrend.html", label: "Multi-Trend", img: "/static/images/icon/trend.png" },
        { href: "http://192.168.1.2:5000/MultiTrendHistory.html", label: "Multi-Trend History", img: "/static/images/icon/History.png" }
      ],
    },
    {
      id: "g_devices",
      name: "Devices",
      expanded: true,
      items: [
        { href: "http://192.168.1.2:5000/inverter.html", label: "Inverters", img: "/static/images/icon/inverter.png" },
        { href: "http://192.168.1.2:5000/EnergyMeter.html", label: "Energy Meters", img: "/static/images/icon/power-meter.png" },
        { href: "http://192.168.1.2:5000/ProtectionRelay.html", label: "Protection Relays", img: "/static/images/icon/protection%20relay.png" },
        { href: "http://192.168.1.2:5000/WeatherStation.html", label: "Weather Station", img: "/static/images/icon/weather-station.png" }
      ],
    },
    {
      id: "g_external",
      name: "External",
      expanded: true,
      items: [{ href: "/user-interface", label: "User-Administration", img: "/static/images/icon/User.png" },
        { href: "/alarm", label: "Alarms", img: "/static/images/icon/Alarm.png" }

      ],
    },
  ];

  function currentPathFileName() {
    try {
      const url = new URL(window.location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || "";
    } catch {
      return "";
    }
  }

  function buildMenu() {
    const activeFile = currentPathFileName().toLowerCase();

    menuEl.innerHTML = "";

    const top = document.createElement("div");
    top.className = "mt-top";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mt-toggle";
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-label", "Toggle menu");
    toggleBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    toggleBtn.addEventListener("click", toggleMenu);

    const brand = document.createElement("div");
    brand.className = "mt-brand";
    brand.innerHTML = '<div class="mt-title">Menu</div><div class="mt-subtitle">All pages</div>';

    top.appendChild(toggleBtn);
    top.appendChild(brand);

    const scroll = document.createElement("div");
    scroll.className = "mt-scroll";

    for (const group of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "mt-group";
      groupEl.id = group.id;
      groupEl.setAttribute("aria-expanded", group.expanded ? "true" : "false");

      const headerBtn = document.createElement("div");
      headerBtn.className = "mt-group-header";
      headerBtn.innerHTML = `<span class="mt-group-name">${escapeHtml(group.name)}</span>`;

      const itemsEl = document.createElement("div");
      itemsEl.className = "mt-items";

      for (const item of group.items) {
        const a = document.createElement("a");
        a.className = "mt-item";
        a.href = item.href;
        if (item.external) a.target = "_blank";
        if (item.external) a.rel = "noopener noreferrer";
        const iconHtml = item.img
          ? `<span class="mt-ico" aria-hidden="true"><img class="mt-ico-img" src="${escapeHtml(item.img)}" alt=""></span>`
          : `<span class="mt-ico" aria-hidden="true">${escapeHtml(item.icon || "•")}</span>`;
        a.innerHTML = `${iconHtml}<span class="mt-label">${escapeHtml(item.label)}</span>`;

        const hrefFile = (item.href || "").split("/").pop().toLowerCase();
        if (!item.external && hrefFile && hrefFile === activeFile) {
          a.classList.add("is-active");
        }

        a.addEventListener("click", () => {
          if (isMobile()) closeMobileMenu();
        });

        itemsEl.appendChild(a);
      }

      groupEl.appendChild(headerBtn);
      groupEl.appendChild(itemsEl);
      scroll.appendChild(groupEl);
    }

    menuEl.appendChild(top);
    menuEl.appendChild(scroll);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function onResize() {
    if (!isMobile()) {
      closeMobileMenu();
      setBackdropVisible(false);
    }
  }

  readState();
  state.mode = "collapsed";   // LOCKED: menu always stays collapsed (icons only)
  applyBodyClasses();
  buildMenu();

  if (openBtnEl) {
    openBtnEl.addEventListener("click", () => {
      toggleMenu();
    });
  }

  if (backdropEl) {
    backdropEl.addEventListener("click", closeMobileMenu);
  }
  window.addEventListener("resize", onResize);
})();

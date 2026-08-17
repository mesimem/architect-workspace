/* ============================================================
   Command Center — shared chrome (nav, sample/real toggle,
   status-dot helper). Every page includes data.js then this
   file, then calls Site.init(activeTabId).
   ============================================================ */

var Site = (function () {

  var TABS = [
    { id: "overview",   label: "Overview",           href: "index.html",   built: true  },
    { id: "outcomes",   label: "Outcomes",            href: "outcomes.html", built: false },
    { id: "users",      label: "Users & use case",     href: "users.html",    built: false },
    { id: "guardrails", label: "Guardrails",           href: "guardrails.html", built: false },
    { id: "systems",    label: "Systems",              href: "systems.html",  built: false },
    { id: "pm",         label: "Project management",   href: "pm.html",       built: false },
    { id: "agents",     label: "AI agents",            href: "agents.html",   built: false },
    { id: "kb",         label: "Knowledge base",       href: "kb.html",       built: false },
    { id: "data-model", label: "Data model",           href: "data-model.html", built: false }
  ];

  var MODE_KEY = "cc-mode";

  function getMode() {
    var m = null;
    try { m = window.localStorage.getItem(MODE_KEY); } catch (e) {}
    return m === "sample" ? "sample" : "real";
  }

  function setMode(mode) {
    try { window.localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    applyMode(mode);
  }

  function applyMode(mode) {
    document.body.classList.toggle("mode-sample", mode === "sample");
    document.body.classList.toggle("mode-real", mode === "real");
    document.querySelectorAll(".mode-toggle button").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    document.dispatchEvent(new CustomEvent("cc-mode-changed", { detail: { mode: mode } }));
  }

  function currentData() {
    return getMode() === "sample" ? SAMPLE_DATA : REAL_DATA;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function daysBetween(aISO, bISO) {
    var a = new Date(aISO + "T00:00:00");
    var b = new Date(bISO + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }

  // status: "unknown" | "up" | "down". lastChecked: ISO string or null.
  function statusDot(status, lastChecked, label) {
    var cls = status === "up" ? "dot-up" : status === "down" ? "dot-down" : "dot-unknown";
    var checkedText = lastChecked ? "checked " + fmtDate(lastChecked) : "never checked";
    return '<span class="status-line">' +
      '<span class="dot ' + cls + '"></span>' +
      '<span class="status-label">' + escapeHtml(label || (status === "up" ? "Live" : status === "down" ? "Down" : "Unknown")) + '</span>' +
      '<span class="status-checked">(' + escapeHtml(checkedText) + ')</span>' +
      '</span>';
  }

  function priorityChip(priority) {
    var cls = priority === "must" ? "chip-must" : priority === "should" ? "chip-should" : "chip";
    return '<span class="chip ' + cls + '">' + escapeHtml(priority) + '</span>';
  }

  function renderNav(activeId) {
    var root = document.getElementById("topnav-root");
    if (!root) return;

    var tabsHtml = TABS.map(function (t) {
      if (!t.built) {
        return '<span class="tab disabled" title="Not built yet">' + escapeHtml(t.label) + '</span>';
      }
      var cls = "tab" + (t.id === activeId ? " active" : "");
      return '<a class="' + cls + '" href="' + t.href + '">' + escapeHtml(t.label) + '</a>';
    }).join("");

    root.innerHTML =
      '<div class="sample-banner">SAMPLE DATA — illustrative only, not produced by this project yet</div>' +
      '<div class="topnav">' +
        '<span class="brand">Command Center</span>' +
        '<nav class="tabs">' + tabsHtml + '</nav>' +
        '<div class="mode-toggle">' +
          '<button type="button" data-mode="real" class="mode-real">Real</button>' +
          '<button type="button" data-mode="sample" class="mode-sample">Sample</button>' +
        '</div>' +
      '</div>';

    root.querySelectorAll(".mode-toggle button").forEach(function (btn) {
      btn.addEventListener("click", function () { setMode(btn.dataset.mode); });
    });
  }

  function init(activeId) {
    renderNav(activeId);
    applyMode(getMode());
  }

  return {
    TABS: TABS,
    init: init,
    getMode: getMode,
    setMode: setMode,
    currentData: currentData,
    escapeHtml: escapeHtml,
    fmtDate: fmtDate,
    daysBetween: daysBetween,
    statusDot: statusDot,
    priorityChip: priorityChip
  };
})();

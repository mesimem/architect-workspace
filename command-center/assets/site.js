/* ============================================================
   Command Center — shared chrome (nav, sample/real toggle,
   "Data as of" stamp, status-dot helper). Every page includes
   data.js then this file, then calls Site.boot(tabId, render)
   or, for a tab not built yet, Site.stubPage(tabId).
   ============================================================ */

var Site = (function () {

  // Every tab is a real, reachable page. `built: false` means the page
  // renders a "not built yet" state - never a locked or greyed link.
  var TABS = [
    { id: "overview",   label: "Overview",           href: "index.html",      built: true,
      desc: "The 30-second view: what this is, where we are in the term, how far along." },
    { id: "outcomes",   label: "Outcomes",           href: "outcomes.html",   built: true,
      desc: "The numbers this platform has to move." },
    { id: "users",      label: "Users & use case",   href: "users.html",      built: true,
      desc: "Who this is for, from the roles named in the user stories." },
    { id: "guardrails", label: "Guardrails",         href: "guardrails.html", built: true,
      desc: "The promises the system makes, and whether a verified story keeps each one." },
    { id: "systems",    label: "Systems",            href: "systems.html",    built: true,
      desc: "External systems this platform connects to." },
    { id: "pm",         label: "Project management", href: "pm.html",         built: true,
      desc: "Releases as a Gantt view, and every story with its due date and baseline." },
    { id: "agents",     label: "AI agents",          href: "agents.html",     built: true,
      desc: "Who owns each story - owners, not a scoped AI agent roster yet." },
    { id: "kb",         label: "Knowledge base",     href: "kb.html",         built: true,
      desc: "Requirements, stories and traceability, with a Q&A panel." },
    { id: "data-model", label: "Data model",         href: "data-model.html", built: true,
      desc: "The stores behind all of the above, read from the backend code and linked to the requirements they serve." }
  ];

  var MODE_KEY = "cc-mode";
  var realModel = null;

  // ?mode=sample or ?mode=real in the address sets the switch, so a demo
  // link or a screenshot can open in a known mode. It is then remembered
  // like a click on the toggle.
  function modeFromUrl() {
    var match = /[?&]mode=(sample|real)\b/.exec(window.location.search);
    return match ? match[1] : null;
  }

  function getMode() {
    var m = null;
    try { m = window.localStorage.getItem(MODE_KEY); } catch (e) { m = null; /* storage blocked: default to real */ }
    return m === "sample" ? "sample" : "real";
  }

  function setMode(mode) {
    try { window.localStorage.setItem(MODE_KEY, mode); } catch (e) { /* storage blocked: mode lasts this page only */ }
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

  // The model for the current mode. Sample is derived from the real
  // model's shape, so it only exists once the real files have loaded.
  function currentData() {
    if (!realModel) return null;
    return getMode() === "sample" ? CCData.sampleModel(realModel) : realModel;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return "-";
    var d = new Date(iso.slice(0, 10) + "T00:00:00");
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function daysBetween(aISO, bISO) {
    var a = new Date(aISO + "T00:00:00");
    var b = new Date(bISO + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }

  function todayISO() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // status: "unknown" | "up" | "down". Grey until something real reports.
  function statusDot(status, lastChecked, label) {
    var cls = status === "up" ? "dot-up" : status === "down" ? "dot-down" : "dot-unknown";
    var checkedText = lastChecked ? "checked " + fmtDate(lastChecked) : "not checked from here";
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

  function sampleTag() {
    return '<span class="sample-tag">SAMPLE</span>';
  }

  // Every card drills down one level: to a tab, or to a detail view.
  function card(href, label, value, sub, sample) {
    return '<a class="card" href="' + href + '">' +
      '<div class="stat-label">' + escapeHtml(label) + (sample ? ' ' + sampleTag() : '') + '</div>' +
      '<div class="stat-value" style="font-size:20px;">' + value + '</div>' +
      '<div class="stat-sub">' + sub + '</div>' +
      '<div class="drill">Details &rarr;</div></a>';
  }

  function pageHeader(tabId, sample) {
    var tab = TABS.filter(function (t) { return t.id === tabId; })[0];
    return '<div class="page-header"><h1>' + escapeHtml(tab.label) + (sample ? ' ' + sampleTag() : '') + '</h1>' +
      '<p class="page-desc">' + escapeHtml(tab.desc) + '</p></div>';
  }

  function detailHref(type, id) {
    return "detail.html?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id);
  }

  // Story state from progress.json. null = no verification run yet, which
  // is "not checked yet" - never rendered as not started or as zero.
  var STATE_LABELS = { verified: "Verified", submitted: "Submitted", in_progress: "In progress", not_started: "Not started" };
  function stateChip(state) {
    var label = state === null || state === undefined ? "Not checked yet" : (STATE_LABELS[state] || state);
    var cls = state === "verified" ? "chip chip-must" : state === "in_progress" || state === "submitted" ? "chip chip-should" : "chip";
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }

  function storyLink(model, id) {
    var s = model.stories.filter(function (x) { return x.id === id; })[0];
    return '<a href="' + detailHref("story", id) + '">' + escapeHtml(id) + '</a>' +
      (s ? ' ' + stateChip(s.state) : ' <span class="chip">not in the plan</span>');
  }

  function renderNav(activeId) {
    var root = document.getElementById("topnav-root");
    if (!root) return;

    var tabsHtml = TABS.map(function (t) {
      var cls = "tab" + (t.id === activeId ? " active" : "");
      return '<a class="' + cls + '" href="' + t.href + '">' + escapeHtml(t.label) + '</a>';
    }).join("");

    root.innerHTML =
      '<div class="sample-banner">SAMPLE DATA - illustrative only, not produced by this project</div>' +
      '<div class="topnav">' +
        '<span class="brand">Command Center</span>' +
        '<nav class="tabs">' + tabsHtml + '</nav>' +
        '<div class="mode-toggle">' +
          '<button type="button" data-mode="real" class="mode-real">Real</button>' +
          '<button type="button" data-mode="sample" class="mode-sample">Sample</button>' +
        '</div>' +
      '</div>' +
      '<div class="data-age" id="data-age">Loading project data...</div>';

    root.querySelectorAll(".mode-toggle button").forEach(function (btn) {
      btn.addEventListener("click", function () { setMode(btn.dataset.mode); });
    });
  }

  function renderDataAge(model) {
    var el = document.getElementById("data-age");
    if (!el) return;
    var age = CCData.dataAge(model.generatedAt, new Date());
    el.className = "data-age age-" + age.level;
    el.textContent = age.text;
  }

  // Shown on Overview while any tab is still unbuilt; disappears on its
  // own once every tab is marked built.
  function pausedBanner() {
    var pending = TABS.filter(function (t) { return !t.built; }).length;
    if (!pending) return "";
    return '<div class="paused-banner"><strong>Build paused for your review.</strong> ' +
      'Overview is built; the other ' + pending + ' tabs are reachable but not built yet. ' +
      'When Overview looks right, tell Claude Code <strong>build the rest</strong>.</div>';
  }

  function renderLoadError(err) {
    var el = document.getElementById("data-age");
    if (el) { el.className = "data-age age-stale"; el.textContent = "Data as of: could not load the project files"; }
    var main = document.getElementById("page-root");
    if (!main) return;
    main.innerHTML = '<div class="section"><div class="empty-state">' +
      '<strong>The project data did not load.</strong> ' + escapeHtml(err && err.message ? err.message : String(err)) + '.<br>' +
      'This page reads <code>.colaberry/plan.json</code>, <code>progress.json</code> and <code>manifest.json</code> at runtime, ' +
      'which a browser will not do from a file opened directly. Serve the repo root over HTTP - ' +
      'for example <code>python -m http.server 8000</code>, then open <code>http://localhost:8000/</code> - or use the GitHub Pages site.' +
      '</div></div>';
  }

  // Load the real files once, then render; re-render on mode change.
  function boot(activeId, render) {
    renderNav(activeId);
    var urlMode = modeFromUrl();
    if (urlMode) setMode(urlMode); else applyMode(getMode());
    CCData.load().then(function (model) {
      realModel = model;
      renderDataAge(model);
      render(currentData());
      document.addEventListener("cc-mode-changed", function () { render(currentData()); });
    }).catch(function (err) {
      console.error(JSON.stringify({ level: "error", service: "command-center", event: "data_load_failed",
        error_class: err && err.name ? err.name : "LoadError", context: { message: String(err && err.message) } }));
      renderLoadError(err);
    });
  }

  // A tab that is not built yet: reachable, labelled, not locked.
  function stubPage(tabId) {
    var tab = TABS.filter(function (t) { return t.id === tabId; })[0];
    boot(tabId, function () {
      document.getElementById("page-root").innerHTML =
        '<div class="page-header"><h1>' + escapeHtml(tab.label) + '</h1>' +
        '<p class="page-desc">' + escapeHtml(tab.desc) + '</p></div>' +
        '<div class="section"><div class="empty-state"><strong>Not built yet.</strong> ' +
        'Say <strong>build the rest</strong> when Overview looks right, and this tab gets built from the same project files.' +
        '</div></div>' +
        '<p><a href="index.html">Back to Overview</a></p>';
    });
  }

  return {
    TABS: TABS,
    boot: boot,
    stubPage: stubPage,
    getMode: getMode,
    setMode: setMode,
    currentData: currentData,
    escapeHtml: escapeHtml,
    fmtDate: fmtDate,
    daysBetween: daysBetween,
    todayISO: todayISO,
    statusDot: statusDot,
    priorityChip: priorityChip,
    sampleTag: sampleTag,
    card: card,
    pageHeader: pageHeader,
    detailHref: detailHref,
    stateChip: stateChip,
    storyLink: storyLink,
    pausedBanner: pausedBanner
  };
})();

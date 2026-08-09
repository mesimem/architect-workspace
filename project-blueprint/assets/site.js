/* Shared rendering, nav, search, theme, and the Ask agent. Renders from the BLUEPRINT data object. */
var Site = (function () {
  var THEME_KEY = "bp-theme";
  var KEY_KEY = "bp-anthropic-key";
  var searchIndexCache = null;

  function slugify(str) {
    return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- Theme ---------------- */
  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    var btn = document.getElementById("theme-toggle");
    if (btn) btn.addEventListener("click", toggleTheme);
  }
  function toggleTheme() {
    var current = document.documentElement.getAttribute("data-theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var effectiveDark = current ? current === "dark" : prefersDark;
    var next = effectiveDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  }

  /* ---------------- Top nav / breadcrumbs / foot nav ---------------- */
  function renderTopnav(activeId, isCommandCenter) {
    var root = document.getElementById("topnav-root");
    if (!root) return;
    var backLink = isCommandCenter ? "" :
      '<a class="cc-link" href="index.html">&larr; Command Center</a>';
    root.innerHTML =
      '<div class="topnav"><div class="topnav-inner">' +
      '<a class="brand" href="index.html">' + escapeHtml(BLUEPRINT.meta.title) + ' <span class="dot">&middot;</span> Blueprint</a>' +
      backLink +
      '<div class="nav-search"><input type="text" id="nav-search-input" placeholder="Search the whole blueprint..." autocomplete="off">' +
      '<div class="search-results" id="nav-search-results"></div></div>' +
      '<button class="icon-btn" id="theme-toggle" title="Toggle light/dark theme">&#9788;</button>' +
      '<button class="icon-btn" id="print-btn" title="Print this page">&#128424;</button>' +
      '</div></div>';
    document.getElementById("print-btn").addEventListener("click", function () { window.print(); });
    wireSearchBox();
  }

  function renderBreadcrumb(activeId) {
    var root = document.getElementById("breadcrumb-root");
    if (!root) return;
    var sec = sectionById(activeId);
    root.innerHTML = '<div class="breadcrumbs container"><a href="index.html">Command Center</a> / ' + escapeHtml(sec.title) + '</div>';
  }

  function sectionById(id) {
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i];
    return null;
  }

  function renderFootNav(activeId) {
    var root = document.getElementById("foot-nav-root");
    if (!root) return;
    var idx = SECTIONS.findIndex(function (s) { return s.id === activeId; });
    var prev = idx > 0 ? SECTIONS[idx - 1] : null;
    var next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;
    var html = '<div class="foot-nav container">';
    html += prev ? '<a href="' + prev.file + '"><div class="lbl">&larr; Previous</div><div class="name">' + escapeHtml(prev.title) + '</div></a>' : '<span></span>';
    html += next ? '<a class="next" href="' + next.file + '"><div class="lbl">Next &rarr;</div><div class="name">' + escapeHtml(next.title) + '</div></a>' : '<span></span>';
    html += '</div>';
    root.innerHTML = html;
  }

  /* ---------------- Scroll progress + back to top ---------------- */
  function initScrollChrome() {
    var bar = document.getElementById("scroll-progress");
    var topBtn = document.getElementById("back-to-top");
    function onScroll() {
      var h = document.documentElement;
      var scrolled = h.scrollTop;
      var max = h.scrollHeight - h.clientHeight;
      var pct = max > 0 ? (scrolled / max) * 100 : 0;
      if (bar) bar.style.width = pct + "%";
      if (topBtn) topBtn.classList.toggle("show", scrolled > 400);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    if (topBtn) topBtn.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
  }

  /* ---------------- Mermaid + expandable diagrams ---------------- */
  function initMermaid(cb) {
    if (!window.mermaid) { if (cb) cb(); return; }
    var isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    mermaid.initialize({ startOnLoad: false, theme: isDark ? "dark" : "default", securityLevel: "loose" });
    mermaid.run({ querySelector: ".mermaid" }).then(function () { wireExpandable(); if (cb) cb(); }).catch(function () { wireExpandable(); if (cb) cb(); });
  }

  function wireExpandable() {
    var cards = document.querySelectorAll(".diagram-card");
    cards.forEach(function (card) {
      if (card.dataset.wired) return;
      card.dataset.wired = "1";
      var toolbar = card.querySelector(".diagram-toolbar");
      if (!toolbar) {
        toolbar = document.createElement("div");
        toolbar.className = "diagram-toolbar";
        card.insertBefore(toolbar, card.firstChild);
      }
      var btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.title = "Expand full screen";
      btn.innerHTML = "&#9974;";
      btn.addEventListener("click", function () { openModal(card); });
      toolbar.appendChild(btn);
    });
  }

  var modalScale = 1;
  function ensureModal() {
    if (document.getElementById("diagram-modal")) return;
    var m = document.createElement("div");
    m.id = "diagram-modal";
    m.innerHTML =
      '<div class="modal-inner">' +
      '<div class="modal-toolbar"><strong id="modal-title"></strong>' +
      '<div class="controls">' +
      '<button class="icon-btn" id="zoom-out" title="Zoom out">&minus;</button>' +
      '<button class="icon-btn" id="zoom-reset" title="Reset zoom">&#8634;</button>' +
      '<button class="icon-btn" id="zoom-in" title="Zoom in">+</button>' +
      '<button class="icon-btn" id="modal-close" title="Close (Esc)">&times;</button>' +
      '</div></div>' +
      '<div class="modal-body"><div class="modal-body-inner" id="modal-content"></div></div>' +
      '</div>';
    document.body.appendChild(m);
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("zoom-in").addEventListener("click", function () { setZoom(modalScale + 0.15); });
    document.getElementById("zoom-out").addEventListener("click", function () { setZoom(modalScale - 0.15); });
    document.getElementById("zoom-reset").addEventListener("click", function () { setZoom(1); });
    m.addEventListener("click", function (e) { if (e.target === m) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  }
  function setZoom(v) {
    modalScale = Math.max(0.4, Math.min(3, v));
    document.getElementById("modal-content").style.transform = "scale(" + modalScale + ")";
  }
  function openModal(card) {
    ensureModal();
    var content = card.querySelector(".mermaid, svg.illustration");
    var title = card.getAttribute("data-title") || "Diagram";
    document.getElementById("modal-title").textContent = title;
    var target = document.getElementById("modal-content");
    target.innerHTML = "";
    if (content) target.appendChild(content.cloneNode(true));
    modalScale = 1;
    target.style.transform = "scale(1)";
    document.getElementById("diagram-modal").classList.add("open");
  }
  function closeModal() {
    var m = document.getElementById("diagram-modal");
    if (m) m.classList.remove("open");
  }

  /* ---------------- Search index ---------------- */
  var STOPWORDS = { a: 1, an: 1, the: 1, of: 1, to: 1, and: 1, or: 1, in: 1, on: 1, for: 1, is: 1, it: 1, this: 1, that: 1, with: 1, as: 1, by: 1, be: 1, are: 1, was: 1 };

  function stem(w) {
    return w.replace(/(ing|ed|es|s)$/i, "");
  }
  function tokenize(text) {
    return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  }

  function buildSearchIndex() {
    if (searchIndexCache) return searchIndexCache;
    var docs = [];
    function add(section, title, text, href) {
      docs.push({ section: section, title: title, text: text, href: href });
    }
    var sec;
    add("summary", "One-line description", BLUEPRINT.meta.oneLiner, "01-summary.html");
    add("summary", "The idea", BLUEPRINT.meta.idea, "01-summary.html");
    BLUEPRINT.components.forEach(function (c) {
      add("components", c.name, c.sentence + " " + c.requiredBy, "02-components.html#" + slugify(c.name));
    });
    add("architecture", "Architecture diagram", BLUEPRINT.diagram.interpretation, "03-architecture.html");
    BLUEPRINT.sequences.forEach(function (s) {
      add("dataflow", s.title, s.interpretation, "04-data-flow.html#" + slugify(s.id));
    });
    BLUEPRINT.buildOrder.phases.forEach(function (p) {
      add("buildorder", "Phase " + p.n + ": " + p.name, p.proves + " " + p.components.join(", "), "05-build-order.html#" + slugify(p.name));
    });
    BLUEPRINT.techStack.forEach(function (t) {
      add("techstack", t.component + " → " + t.tech, t.why, "06-tech-stack.html#" + slugify(t.component));
    });
    BLUEPRINT.assumptions.forEach(function (a, i) {
      add("assumptions", "Assumption: " + a.text, a.impact, "07-assumptions.html#assumption-" + i);
    });
    BLUEPRINT.notCovered.forEach(function (n, i) {
      add("assumptions", "Not covered", n, "07-assumptions.html#notcovered-" + i);
    });
    add("assumptions", "Open question: " + BLUEPRINT.openQuestion.question, BLUEPRINT.openQuestion.branchA.detail + " " + BLUEPRINT.openQuestion.branchB.detail, "07-assumptions.html#open-question");

    docs.forEach(function (d) {
      d.titleTokens = tokenize(d.title).map(stem);
      d.textTokens = tokenize(d.text).map(stem);
      d.lowerText = (d.title + " " + d.text).toLowerCase();
    });
    searchIndexCache = docs;
    return docs;
  }

  function search(query, limit) {
    query = (query || "").trim();
    if (!query) return [];
    var qTokensRaw = tokenize(query);
    var qTokens = qTokensRaw.map(stem).filter(function (t) { return t.length > 1 && !STOPWORDS[t]; });
    if (!qTokens.length) return [];
    var qPhrase = query.toLowerCase();
    var docs = buildSearchIndex();
    var scored = docs.map(function (d) {
      var score = 0;
      qTokens.forEach(function (t) {
        d.titleTokens.forEach(function (tt) { if (tt === t || tt.indexOf(t) === 0) score += 5; });
        d.textTokens.forEach(function (tt) { if (tt === t || tt.indexOf(t) === 0) score += 1; });
      });
      if (d.lowerText.indexOf(qPhrase) !== -1) score += 8;
      return { doc: d, score: score };
    }).filter(function (s) { return s.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 8).map(function (s) {
      return { section: s.doc.section, title: s.doc.title, href: s.doc.href, snippet: makeSnippet(s.doc.text, qTokens) };
    });
  }

  function makeSnippet(text, qTokens) {
    var lower = text.toLowerCase();
    var pos = -1;
    for (var i = 0; i < qTokens.length; i++) {
      var p = lower.indexOf(qTokens[i]);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    }
    var start = Math.max(0, (pos === -1 ? 0 : pos) - 40);
    var snippet = (start > 0 ? "…" : "") + text.substring(start, start + 140) + (start + 140 < text.length ? "…" : "");
    return highlight(snippet, qTokens);
  }

  function highlight(text, qTokens) {
    var escaped = escapeHtml(text);
    qTokens.forEach(function (t) {
      if (!t) return;
      var re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\w*)", "gi");
      escaped = escaped.replace(re, "<mark>$1</mark>");
    });
    return escaped;
  }

  function wireSearchBox() {
    var input = document.getElementById("nav-search-input");
    var resultsBox = document.getElementById("nav-search-results");
    if (!input) return;
    input.addEventListener("input", function () {
      var q = input.value;
      filterPageContent(q);
      if (!q.trim()) { resultsBox.classList.remove("open"); resultsBox.innerHTML = ""; return; }
      var results = search(q, 8);
      if (!results.length) {
        resultsBox.innerHTML = '<div class="search-empty">No matches anywhere in the blueprint for &ldquo;' + escapeHtml(q) + '&rdquo;.</div>';
      } else {
        resultsBox.innerHTML = results.map(function (r) {
          var sec = sectionById(r.section);
          return '<a class="search-result" href="' + r.href + '"><div class="sec">' + escapeHtml(sec ? sec.title : r.section) + '</div>' +
            '<div>' + highlight(r.title, tokenize(q).map(stem)) + '</div>' +
            '<div class="snippet">' + r.snippet + '</div></a>';
        }).join("");
      }
      resultsBox.classList.add("open");
    });
    document.addEventListener("click", function (e) {
      if (!resultsBox.contains(e.target) && e.target !== input) resultsBox.classList.remove("open");
    });
  }

  function filterPageContent(q) {
    var items = document.querySelectorAll(".searchable");
    var terms = tokenize(q).map(stem).filter(function (t) { return t.length > 1; });
    items.forEach(function (el) {
      if (!terms.length) { el.style.display = ""; return; }
      var text = el.textContent.toLowerCase();
      var hit = terms.some(function (t) { return text.indexOf(t) !== -1; });
      el.style.display = hit ? "" : "none";
    });
  }

  /* ---------------- Ask panel ---------------- */
  function renderAskPanel(containerId, scopeLabel, scopeDataFn) {
    var root = document.getElementById(containerId);
    if (!root) return;
    root.innerHTML =
      '<div class="ask-panel"><h2>Ask the blueprint</h2>' +
      '<div class="ask-tabs">' +
      '<button class="ask-tab active" data-mode="search">Search — no key</button>' +
      '<button class="ask-tab" data-mode="claude">Claude — needs key</button>' +
      '</div>' +
      '<div class="ask-row"><input type="text" id="ask-input" placeholder="Ask a question about this blueprint..."><button class="ask-btn" id="ask-submit">Ask</button></div>' +
      '<div class="ask-config" id="ask-config">' +
      '<input type="password" id="ask-key" placeholder="Paste your Anthropic API key">' +
      '<select id="ask-model">' +
      '<option value="claude-opus-5">claude-opus-5</option>' +
      '<option value="claude-sonnet-5">claude-sonnet-5</option>' +
      '<option value="claude-haiku-4-5">claude-haiku-4-5</option>' +
      '</select>' +
      '<select id="ask-scope"><option value="section">This section (' + escapeHtml(scopeLabel) + ')</option><option value="all">Whole blueprint</option></select>' +
      '</div>' +
      '<div class="ask-note">Search mode works fully offline, no API key or network needed. Claude mode sends your key only to api.anthropic.com; it is stored in this browser’s localStorage and never hardcoded.</div>' +
      '<div id="ask-output" style="margin-top:14px;"></div></div>';

    var mode = "search";
    var savedKey = localStorage.getItem(KEY_KEY);
    if (savedKey) document.getElementById("ask-key").value = savedKey;

    root.querySelectorAll(".ask-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        root.querySelectorAll(".ask-tab").forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        mode = tab.dataset.mode;
        document.getElementById("ask-config").classList.toggle("show", mode === "claude");
      });
    });

    document.getElementById("ask-submit").addEventListener("click", function () { runAsk(); });
    document.getElementById("ask-input").addEventListener("keydown", function (e) { if (e.key === "Enter") runAsk(); });

    function runAsk() {
      var q = document.getElementById("ask-input").value.trim();
      var out = document.getElementById("ask-output");
      if (!q) return;
      if (mode === "search") {
        var results = search(q, 6);
        if (!results.length) {
          out.innerHTML = '<div class="ask-error">No matches in the blueprint for that. A miss can be the answer itself — check <a href="07-assumptions.html">Assumptions &amp; Scope</a> for what was deliberately left out.</div>';
          return;
        }
        out.innerHTML = results.map(function (r) {
          var sec = sectionById(r.section);
          return '<div class="ask-card"><div class="sec">' + escapeHtml(sec ? sec.title : r.section) + '</div>' +
            '<div><strong>' + escapeHtml(r.title) + '</strong></div>' +
            '<div class="snippet">' + r.snippet + '</div>' +
            '<div style="margin-top:6px;"><a href="' + r.href + '">Open section →</a></div></div>';
        }).join("");
        return;
      }
      // Claude mode
      var key = document.getElementById("ask-key").value.trim();
      var model = document.getElementById("ask-model").value;
      var scope = document.getElementById("ask-scope").value;
      if (!key) { out.innerHTML = '<div class="ask-error">Paste your Anthropic API key above, or switch to Search mode.</div>'; return; }
      localStorage.setItem(KEY_KEY, key);
      var scopeData = scope === "section" && scopeDataFn ? scopeDataFn() : BLUEPRINT;
      out.innerHTML = '<div class="ask-note">Asking Claude…</div>';
      var btn = document.getElementById("ask-submit");
      btn.disabled = true;
      var systemPrompt = "You are answering questions about a system architecture blueprint called \"" + BLUEPRINT.meta.title +
        "\". Answer ONLY using the following BLUEPRINT JSON data. If the answer is not covered by this data, say so plainly and suggest the user try Search mode or check the Assumptions & Scope page.\n\nBLUEPRINT DATA:\n" + JSON.stringify(scopeData);
      var body = { model: model, max_tokens: 16000, system: systemPrompt, messages: [{ role: "user", content: q }] };
      if (model !== "claude-haiku-4-5") body.output_config = { effort: "low" };
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error((res.status === 401 ? "Invalid API key. " : res.status === 429 ? "Rate limited. " : "Request failed (" + res.status + "). ") + "Try Search mode instead.");
          });
        }
        return res.json();
      }).then(function (data) {
        btn.disabled = false;
        if (data.stop_reason === "refusal") {
          out.innerHTML = '<div class="ask-error">Claude declined to answer that. Try rephrasing, or use Search mode.</div>';
          return;
        }
        var text = (data.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n");
        out.innerHTML = '<div class="ask-card"><div class="ask-answer">' + escapeHtml(text || "(no text returned)") + '</div></div>';
      }).catch(function (err) {
        btn.disabled = false;
        out.innerHTML = '<div class="ask-error">' + escapeHtml(err.message || "Something went wrong reaching the Claude API.") + ' Falling back is easy — switch to Search mode above.</div>';
      });
    }
  }

  /* ---------------- Inline SVG illustrations ---------------- */
  var svg = {
    nodeGraph: function (w, h) {
      w = w || 260; h = h || 90;
      var nodes = [[30, 45], [95, 20], [95, 70], [165, 45], [230, 20], [230, 70]];
      var edges = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5]];
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      edges.forEach(function (e) {
        var a = nodes[e[0]], b = nodes[e[1]];
        s += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" style="stroke:var(--border);stroke-width:2" />';
      });
      nodes.forEach(function (n, i) {
        s += '<circle cx="' + n[0] + '" cy="' + n[1] + '" r="9" style="fill:' + (i === 3 ? 'var(--accent)' : 'var(--blue)') + '" />';
      });
      s += '</svg>';
      return s;
    },
    flowRibbon: function (steps, w, h) {
      w = w || 260; h = h || 90;
      var n = steps.length;
      var gap = w / n;
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      for (var i = 0; i < n; i++) {
        var cx = gap * i + gap / 2;
        if (i < n - 1) s += '<line x1="' + (cx + 12) + '" y1="45" x2="' + (cx + gap - 12) + '" y2="45" style="stroke:var(--border);stroke-width:2" />';
        s += '<circle cx="' + cx + '" cy="45" r="12" style="fill:var(--card);stroke:var(--accent);stroke-width:2" />';
        s += '<text x="' + cx + '" y="49" text-anchor="middle" style="fill:var(--accent);font-size:11px;font-weight:700">' + (i + 1) + '</text>';
      }
      s += '</svg>';
      return s;
    },
    phaseBars: function (phases, w, h) {
      w = w || 260; h = h || 90;
      var totalWeeks = phases.reduce(function (a, p) { return a + p.weeks; }, 0);
      var x = 6, barH = 16, gap = 6;
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      var y = 10;
      phases.forEach(function (p) {
        var bw = ((w - 12) * p.weeks) / totalWeeks;
        s += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + barH + '" rx="3" style="fill:' + (p.critical ? 'var(--accent)' : 'var(--blue)') + '" />';
        y += barH + gap;
      });
      s += '</svg>';
      return s;
    },
    fitDots: function (items, w, h) {
      w = w || 260; h = h || 90;
      var cols = 3, r = 8, xGap = w / cols, yGap = 26;
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      var colorMap = { green: "var(--green)", yellow: "var(--amber)", red: "var(--red)" };
      items.forEach(function (t, i) {
        var col = i % cols, row = Math.floor(i / cols);
        var cx = xGap * col + xGap / 2, cy = 16 + row * yGap;
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" style="fill:' + colorMap[t.fit] + '" />';
      });
      s += '</svg>';
      return s;
    },
    fork: function (w, h) {
      w = w || 260; h = h || 90;
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      s += '<circle cx="30" cy="45" r="8" style="fill:var(--accent)" />';
      s += '<line x1="38" y1="45" x2="120" y2="45" style="stroke:var(--border);stroke-width:2" />';
      s += '<line x1="120" y1="45" x2="220" y2="18" style="stroke:var(--green);stroke-width:2" />';
      s += '<line x1="120" y1="45" x2="220" y2="72" style="stroke:var(--red);stroke-width:2" />';
      s += '<circle cx="120" cy="45" r="6" style="fill:var(--border)" />';
      s += '<circle cx="228" cy="18" r="9" style="fill:var(--green)" />';
      s += '<circle cx="228" cy="72" r="9" style="fill:var(--red)" />';
      s += '</svg>';
      return s;
    },
    layers: function (count, w, h) {
      w = w || 260; h = h || 90;
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      var rows = 3, cols = Math.ceil(count / rows);
      var cw = (w - 12) / cols, ch = 20;
      for (var i = 0; i < count; i++) {
        var col = i % cols, row = Math.floor(i / cols);
        s += '<rect x="' + (6 + col * cw + 3) + '" y="' + (6 + row * (ch + 6)) + '" width="' + (cw - 6) + '" height="' + ch + '" rx="4" style="fill:var(--card);stroke:var(--blue);stroke-width:2" />';
      }
      s += '</svg>';
      return s;
    },
    paragraph: function (w, h) {
      w = w || 260; h = h || 90;
      var s = '<svg class="illustration" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
      var widths = [0.9, 0.75, 0.85, 0.6, 0.7];
      widths.forEach(function (wf, i) {
        s += '<rect x="10" y="' + (10 + i * 16) + '" width="' + (w - 20) * wf + '" height="8" rx="4" style="fill:' + (i === 0 ? 'var(--accent)' : 'var(--border)') + '" />';
      });
      s += '</svg>';
      return s;
    }
  };

  /* ---------------- Init ---------------- */
  function init(activeId, opts) {
    opts = opts || {};
    initTheme();
    renderTopnav(activeId, !!opts.isCommandCenter);
    if (!opts.isCommandCenter) {
      renderBreadcrumb(activeId);
      renderFootNav(activeId);
    }
    initScrollChrome();
    if (opts.hasMermaid) initMermaid(opts.onMermaidDone); else wireExpandable();
  }

  return {
    slugify: slugify, escapeHtml: escapeHtml, init: init, search: search, buildSearchIndex: buildSearchIndex,
    renderAskPanel: renderAskPanel, svg: svg, wireExpandable: wireExpandable, initMermaid: initMermaid
  };
})();

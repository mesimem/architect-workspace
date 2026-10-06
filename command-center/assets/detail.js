/* ============================================================
   Command Center — the one-level-down detail view.
   detail.html?type=<type>&id=<id>. Every card on every tab links
   here (or to a tab). An item with nothing behind it yet still
   gets a page saying what will be here and what must happen first.
   ============================================================ */

var Detail = (function () {
  var esc = Site.escapeHtml;

  function param(name) {
    var m = new RegExp("[?&]" + name + "=([^&]*)").exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
  }

  function find(list, key, id) {
    return list.filter(function (x) { return x[key] === id; })[0];
  }

  function rows(pairs) {
    return '<table class="kv">' + pairs.map(function (p) {
      return '<tr><th>' + esc(p[0]) + '</th><td>' + p[1] + '</td></tr>';
    }).join("") + '</table>';
  }

  function list(items) {
    return items.length ? '<ul>' + items.map(function (i) { return '<li>' + i + '</li>'; }).join("") + '</ul>' : '<p class="stat-sub">None.</p>';
  }

  function storyLinks(model, ids) {
    return ids.length ? ids.map(function (id) { return Site.storyLink(model, id); }).join("<br>") : "none";
  }

  var RENDER = {
    story: function (m, id) {
      var s = find(m.stories, "id", id);
      if (!s) return null;
      var slip = s.slipDays === null ? "-" : s.slipDays === 0 ? "on baseline" : (s.slipDays > 0 ? s.slipDays + " days later than first given" : Math.abs(s.slipDays) + " days earlier");
      var criteria = s.criteria.length ? s.criteria.map(function (c) { return (c.passed ? "[x] " : "[ ] ") + esc(c.text); })
        : s.acceptance.map(function (a) { return "[ ] " + esc(a) + ' <span class="stat-sub">(not checked yet)</span>'; });
      return { title: s.id + " - " + s.title, back: "pm.html", body:
        '<p>' + esc(s.narrative || "") + '</p>' +
        rows([["State", Site.stateChip(s.state)], ["Release", esc(s.release)], ["Owner", esc(s.owner || "-")],
          ["Due", esc(Site.fmtDate(s.dueOn))], ["Baseline due", esc(Site.fmtDate(s.dueBaselineOn))], ["Slippage", esc(slip)],
          ["Fulfils", s.fulfills.map(function (r) { return '<a href="' + Site.detailHref("requirement", r) + '">' + esc(r) + '</a>'; }).join(", ") || "-"],
          ["Blocked by", storyLinks(m, s.blockedBy)],
          ["Verified commit", s.commitUrl ? '<a href="' + esc(s.commitUrl) + '">' + esc(s.commitUrl.split("/").pop().slice(0, 7)) + '</a>' : "none yet"]]) +
        '<h2>Acceptance criteria</h2>' + list(criteria) +
        '<h2>Failure paths</h2>' + list(s.failurePaths.map(esc)) +
        (s.notes ? '<h2>Build notes</h2><p class="stat-sub">' + esc(s.notes) + '</p>' : '') };
    },
    requirement: function (m, id) {
      var r = find(m.requirements, "id", id);
      if (!r) return null;
      return { title: r.id, back: "kb.html", body: '<p>' + esc(r.statement) + '</p>' +
        rows([["Kind", esc(r.kind)], ["Priority", Site.priorityChip(r.priority)], ["Capability", esc(r.cluster || "-")],
          ["Fulfilled by", storyLinks(m, r.fulfilledBy)],
          ["Built", r.built ? "Yes - every fulfilling story is verified" : r.fulfilledBy.length ? "Not yet" : "No story covers this requirement"]]) };
    },
    release: function (m, id) {
      var r = find(m.releases, "key", id);
      if (!r) return null;
      return { title: r.key + " - " + r.name, back: "pm.html", body:
        rows([["Dates", esc(Site.fmtDate(r.startsOn) + " to " + Site.fmtDate(r.endsOn))], ["Demo target", r.isDemoTarget ? "Yes" : "No"],
          ["Goal", esc(r.goal)], ["Demo", esc(r.demo)], ["Verified", esc(r.verifiedCount + " of " + r.storyIds.length + " stories")]]) +
        '<h2>Stories</h2>' + list(r.storyIds.map(function (sid) {
          var s = find(m.stories, "id", sid);
          return Site.storyLink(m, sid) + (s ? " " + esc(s.title) : "");
        })) };
    },
    guardrail: function (m, id) {
      var g = find(m.guardrails, "id", id);
      if (!g) return null;
      return { title: "Guardrail " + g.id, back: "guardrails.html", body: '<p>' + esc(g.statement) + '</p>' +
        rows([["Status", g.kept ? "Kept - every enforcing story is verified" : "A promise made and not yet kept"],
          ["Enforced by", storyLinks(m, g.enforcedBy)],
          ["Requirement", '<a href="' + Site.detailHref("requirement", g.id) + '">' + esc(g.id) + '</a>']]) };
    },
    role: function (m, id) {
      var r = find(m.roles, "name", id);
      if (!r) return null;
      return { title: "Role: " + r.name, back: "users.html", body: '<h2>What they are trying to get done</h2>' +
        (r.storyIds.length ? list(r.storyIds.map(function (sid) {
          return Site.storyLink(m, sid) + '<br><span class="stat-sub">' + esc(find(m.stories, "id", sid).narrative) + '</span>';
        })) : '<div class="empty-state">No story is written "As a ' + esc(r.name) + '" yet. The role is named in the plan, but nothing describes what they need.</div>') };
    },
    owner: function (m, id) {
      var a = find(m.agents, "name", id);
      if (a) {
        return { title: a.name, back: "agents.html", body: '<p>' + esc(a.purpose || "") + '</p>' +
          rows([["Trigger", esc((a.trigger_type || "") + " " + (a.trigger || ""))], ["Autonomy", esc(a.autonomy_level || "-")],
            ["Inputs", esc((a.inputs || []).join(", ") || "-")], ["Outputs", esc((a.outputs || []).join(", ") || "-")],
            ["Approval gates", esc((a.approval_gates || []).join("; ") || "-")], ["Escalation", esc((a.escalation_rules || []).join("; ") || "-")],
            ["Skills", (a.skills || []).length ? esc(a.skills.join(", ")) : "No skills registered yet"],
            ["Runs", "No runs recorded"], ["Owns", storyLinks(m, a.owns || [])]]) };
      }
      var o = find(m.owners, "name", id);
      if (!o) return null;
      return { title: o.name, back: "agents.html", body:
        '<p class="stat-sub">A story owner named in the plan, not a scoped AI agent.</p>' +
        rows([["Skills", "No skills registered yet"], ["Runs", "No runs recorded"], ["Owns", storyLinks(m, o.storyIds)]]) };
    },
    measure: function (m, id) {
      var x = find(m.measures, "id", id);
      if (!x) return null;
      return { title: x.id, back: "outcomes.html", body: '<p>' + esc(x.statement) + '</p>' +
        rows([["Current value", "Not measured - this comes from the running system, not from the plan"]]) };
    },
    system: function (m, id) {
      if (m.systems.indexOf(id) < 0) return null;
      return { title: id, back: "systems.html", body: Site.statusDot("unknown", null, "Connection not checked") +
        '<p class="stat-sub">Named in the plan. Nothing in this repo can reach it, so its status stays grey until the running system reports it.</p>' };
    },
    entity: function (m, id) {
      var e = find(m.dataModel.entities || [], "store", id);
      if (!e) return null;
      return { title: e.entity, back: "data-model.html", body: '<p class="stat-sub">' + esc(e.notes || "") + '</p>' +
        rows([["Store", '<code>' + esc(e.store) + '</code>'], ["Key", esc(e.key)], ["Source", '<code>' + esc(e.source) + '</code>'],
          ["Stories", storyLinks(m, e.stories || [])]]) +
        '<h2>Fields</h2>' + list(e.fields.map(function (f) { return '<code>' + esc(f) + '</code>'; })) +
        '<h2>Relationships</h2>' + list((e.relationships || []).map(function (r) {
          return '<code>' + esc(r.field) + '</code> &rarr; <a href="' + Site.detailHref("entity", r.references) + '">' + esc(r.references) + '</a>';
        })) };
    },
    note: function (m, id) {
      var n = m.notes[Number(id)];
      if (!n) return null;
      return { title: n.title, back: "kb.html", body: '<p>' + esc(n.body) + '</p>' +
        rows([["Kind", esc(n.kind)], ["Date", esc(Site.fmtDate(n.date))], ["Evidence", '<code>' + esc(n.evidence || "none") + '</code>']]) };
    },
    // A card with nothing behind it yet: say what will be here.
    empty: function (m, id) {
      var EMPTY = {
        measures: ["Outcome measures", "outcomes.html", "One card per number this system has to move, each with its target and its measured value.", "Add a numeric target to the plan in the portal; the value comes later, from the running system."],
        systems: ["External systems", "systems.html", "Each external system with a status dot and the time it was last checked.", "Name the system in a CONSTRAINT requirement in the plan; a live status needs the running system to report it."],
        agents: ["Scoped AI agents", "agents.html", "One card per agent: purpose, trigger, inputs, outputs, autonomy, approval gates and the stories it owns.", "Scope an agent roster in the plan."],
        notes: ["Knowledge base notes", "kb.html", "Decisions, limits and notes, newest first.", "Append an entry to command-center/kb-notes.json."]
      };
      var e = EMPTY[id];
      if (!e) return null;
      return { title: e[0], back: e[1], body: '<div class="empty-state"><strong>Nothing here yet.</strong> ' + esc(e[2]) +
        '<br><br><strong>What has to happen first:</strong> ' + esc(e[3]) + '</div>' };
    }
  };

  function render(model) {
    var type = param("type"), id = param("id");
    var page = RENDER[type] ? RENDER[type](model, id) : null;
    var root = document.getElementById("page-root");
    if (!page) {
      root.innerHTML = '<div class="page-header"><h1>Not found</h1></div><div class="empty-state">There is no ' +
        esc(type || "item") + ' "' + esc(id) + '" in this project\'s data.</div><p><a href="index.html">Back to Overview</a></p>';
      return;
    }
    document.title = page.title + " - Command Center";
    root.innerHTML = '<p><a href="' + page.back + '">&larr; Back</a></p>' +
      '<div class="page-header"><h1>' + esc(page.title) + (model.isSample ? ' ' + Site.sampleTag() : '') + '</h1></div>' +
      '<div class="card detail">' + page.body + '</div>';
  }

  return { render: render };
})();

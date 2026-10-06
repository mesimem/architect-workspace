/* ============================================================
   Command Center — knowledge-base Q&A
   Answers questions from the loaded model only, and cites the tab
   each answer came from. Deterministic keyword matching, not a
   language model: a static public page cannot hold an API key, and
   an answer that guesses is worse than one that says it cannot
   answer. Pure function - tested in tests/commandCenter.test.js.
   ============================================================ */

var KbChat = (function () {

  var TABS = {
    overview: { label: "Overview", href: "index.html" },
    outcomes: { label: "Outcomes", href: "outcomes.html" },
    users: { label: "Users & use case", href: "users.html" },
    guardrails: { label: "Guardrails", href: "guardrails.html" },
    systems: { label: "Systems", href: "systems.html" },
    pm: { label: "Project management", href: "pm.html" },
    agents: { label: "AI agents", href: "agents.html" },
    kb: { label: "Knowledge base", href: "kb.html" },
    "data-model": { label: "Data model", href: "data-model.html" }
  };

  var STATE_TEXT = { verified: "verified", submitted: "submitted", in_progress: "in progress", not_started: "not started" };

  function stateText(state) {
    return state === null || state === undefined ? "not checked yet" : (STATE_TEXT[state] || state);
  }

  function reply(text, tab) {
    return { text: text, tab: tab, cite: TABS[tab] };
  }

  function byId(list, id) {
    return list.filter(function (x) { return x.id === id; })[0];
  }

  function aboutStory(model, id) {
    var s = byId(model.stories, id);
    if (!s) return reply(id + " is not in the plan.", "pm");
    var criteria = s.criteriaPassed === null ? "criteria not checked yet" : s.criteriaPassed + " of " + s.criteriaTotal + " criteria passed";
    return reply(s.id + " - " + s.title + ". Release " + s.release + ", owned by " + (s.owner || "nobody") +
      ". State: " + stateText(s.state) + " (" + criteria + "). Due " + (s.dueOn || "with no date") + ".", "pm");
  }

  function aboutRequirement(model, id) {
    var r = byId(model.requirements, id);
    if (!r) return reply(id + " is not in the plan.", "kb");
    var by = r.fulfilledBy.length ? r.fulfilledBy.join(", ") : "no story";
    return reply(r.id + " (" + r.kind + ", " + r.priority + "): " + r.statement + " Fulfilled by " + by +
      "; " + (r.built ? "built - every fulfilling story is verified." : "not built yet."), "kb");
  }

  function answer(question, model) {
    var q = String(question || "").trim();
    if (!q) return reply("Ask about a story or requirement by its id, a release key, progress, guardrails, owners, roles, systems, outcomes or the data model.", "kb");
    var lower = q.toLowerCase();

    var story = /story-\d+/i.exec(q);
    if (story) return aboutStory(model, story[0].toUpperCase());
    var req = /req-\d+/i.exec(q);
    if (req) return aboutRequirement(model, req[0].toUpperCase());

    var rel = /\br(\d+)\b/i.exec(q);
    if (rel) {
      var r = model.releases.filter(function (x) { return x.key === "r" + rel[1]; })[0];
      if (!r) return reply("There is no release r" + rel[1] + " in the plan.", "pm");
      return reply(r.key + " - " + r.name + ": " + r.verifiedCount + " of " + r.storyIds.length + " stories verified (" +
        r.storyIds.join(", ") + "). " + (r.startsOn ? r.startsOn + " to " + r.endsOn + "." : "Not scheduled."), "pm");
    }

    if (/guardrail|safe|promise|never/.test(lower)) {
      var kept = model.guardrails.filter(function (g) { return g.kept; });
      return reply(kept.length + " of " + model.guardrails.length + " guardrails are kept by verified stories. " +
        model.guardrails.map(function (g) { return g.id + (g.kept ? " kept" : " not yet kept"); }).join("; ") + ".", "guardrails");
    }
    if (/demo/.test(lower)) {
      var s = model.schedule;
      return reply("Demo day is " + (s.demo_day || "not set") + ", demoing release " + (s.demo_release_key || "not set") + ".", "pm");
    }
    if (/gap|uncovered|missing|not built|unbuilt/.test(lower)) {
      var gaps = model.requirements.filter(function (x) { return !x.built; });
      var orphan = gaps.filter(function (x) { return !x.fulfilledBy.length; }).map(function (x) { return x.id; });
      return reply(gaps.length + " of " + model.requirements.length + " requirements are not built: " +
        gaps.map(function (x) { return x.id; }).join(", ") + "." +
        (orphan.length ? " No story covers " + orphan.join(", ") + "." : ""), "kb");
    }
    if (/how many|progress|verified|done|complete|points|how far/.test(lower)) {
      var t = model.totals;
      if (!t) return reply("progress.json carries no totals yet.", "overview");
      return reply(t.stories_verified + " of " + t.stories_total + " stories verified, " + t.criteria_passed + " of " +
        t.criteria_total + " criteria passed, " + t.points_awarded + " points.", "overview");
    }
    if (/owner|owns|agent|who is responsible/.test(lower)) {
      return reply((model.agents.length ? "The plan has " + model.agents.length + " scoped agents. " : "The plan has no scoped AI agents yet; stories have owners: ") +
        model.owners.map(function (o) { return o.name + " (" + o.storyIds.length + ")"; }).join(", ") + ".", "agents");
    }
    if (/role|user|who is (this|it) for|persona|customer/.test(lower)) {
      return reply("Stories are written for: " + model.roles.map(function (x) { return x.name; }).join(", ") + ".", "users");
    }
    if (/system|integrat|connect|external/.test(lower)) {
      return reply(model.systems.length ? "The plan names: " + model.systems.join(", ") + ". Whether any is connected is not checked from here." :
        "The plan names no external system yet.", "systems");
    }
    if (/outcome|measure|kpi|target|metric/.test(lower)) {
      return reply(model.measures.length ? model.measures.length + " measures: " + model.measures.map(function (m) { return m.statement; }).join("; ") + ". No values are measured here." :
        "The plan carries no numeric target yet.", "outcomes");
    }
    if (/store|table|data model|entity|schema|field/.test(lower)) {
      var e = model.dataModel.entities || [];
      return reply(e.length + " stores: " + e.map(function (x) { return x.entity; }).join(", ") + ".", "data-model");
    }
    return reply("I can't answer that from this page's data. Try a story or requirement id, a release key, progress, guardrails, owners, roles, systems, outcomes or the data model.", "kb");
  }

  return { answer: answer };
})();

if (typeof module !== "undefined" && module.exports) module.exports = KbChat;

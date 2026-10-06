/* ============================================================
   Command Center — data layer
   Every tab reads the project from the three files the platform
   commits beside this page, fetched at runtime:
     .colaberry/plan.json      the plan (what was planned)
     .colaberry/progress.json  the state (what has happened)
     .colaberry/manifest.json  freshness (generated_at)
   Nothing about the project is typed into this file. See
   docs/DATA_CONTRACT.md for the shapes and the join on story id.

   Works in the browser (global CCData) and in Node (module.exports)
   so the pure functions are unit-tested in tests/commandCenter.test.js.
   ============================================================ */

var CCData = (function () {

  var BASE = "../.colaberry/";
  var DAY_MS = 86400000;
  var STALE_AFTER_DAYS = 7;

  // ---- Loading -----------------------------------------------------
  // A missing or unparseable file is a hard failure with a named
  // reason: rendering a half-model would show a page that looks
  // complete and is not.
  function fetchJson(name) {
    return fetch(BASE + name, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(name + " could not be loaded (HTTP " + res.status + ")");
      return res.json();
    });
  }

  // The two project-authored files live beside the page, not in
  // .colaberry/: the data model is a design artifact derived from the
  // backend code, and the knowledge-base notes are added by hand.
  function fetchLocal(name) {
    return fetch(name, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(name + " could not be loaded (HTTP " + res.status + ")");
      return res.json();
    });
  }

  function load() {
    return Promise.all([
      fetchJson("plan.json"),
      fetchJson("progress.json"),
      fetchJson("manifest.json"),
      fetchLocal("data-model.json"),
      fetchLocal("kb-notes.json")
    ]).then(function (files) {
      return buildModel(files[0], files[1], files[2], { dataModel: files[3], notes: files[4] });
    });
  }

  // ---- The join ------------------------------------------------------
  // Story state comes from progress, never from plan. An absent
  // verification block means "not checked yet", which is a different
  // fact from zero - state stays null so the page can say so.
  function buildModel(plan, progress, manifest, extras) {
    extras = extras || {};
    var progressById = {};
    (progress.stories || []).forEach(function (s) { progressById[s.id] = s; });

    var stories = (plan.stories || []).map(function (story) {
      var p = progressById[story.id];
      var v = p && p.verification ? p.verification : null;
      return {
        id: story.id,
        title: story.title,
        release: story.release,
        narrative: story.narrative,
        owner: story.owner_agent || null,
        fulfills: story.fulfills || [],
        acceptance: story.acceptance || [],
        blockedBy: story.blocked_by || [],
        failurePaths: story.failure_paths || [],
        dueOn: story.due_on || null,
        dueBaselineOn: story.due_baseline_on || null,
        slipDays: slipDays(story.due_baseline_on, story.due_on),
        criteria: p ? p.criteria || [] : [],
        notes: p ? p.notes || null : null,
        state: v ? v.state : null,
        criteriaPassed: v ? v.criteria_passed : null,
        criteriaTotal: v ? v.criteria_total : (story.acceptance || []).length,
        commitUrl: v ? v.commit_url : null
      };
    });
    var storyById = {};
    stories.forEach(function (s) { storyById[s.id] = s; });

    var isVerified = function (id) {
      return Boolean(storyById[id]) && storyById[id].state === "verified";
    };

    // A requirement is "built" when every story that fulfils it is
    // verified. Derived on every load, never stored.
    var requirements = (plan.requirements || []).map(function (r) {
      var by = r.fulfilled_by || [];
      return {
        id: r.id, statement: r.statement, kind: r.kind, priority: r.priority,
        cluster: r.cluster, fulfilledBy: by,
        built: by.length > 0 && by.every(isVerified)
      };
    });
    var reqById = {};
    requirements.forEach(function (r) { reqById[r.id] = r; });

    var derived = plan.derived || {};
    var guardrails = (derived.guardrails || []).map(function (g) {
      var req = reqById[g.id];
      return {
        id: g.id,
        statement: g.statement,
        enforcedBy: req ? req.fulfilledBy : [],
        kept: Boolean(req && req.built)
      };
    });

    var releases = (plan.releases || []).map(function (r) {
      var ids = r.story_ids || [];
      return {
        key: r.key, name: r.name, goal: r.goal || "", demo: r.demo || "",
        startsOn: r.starts_on || null, endsOn: r.ends_on || null,
        isDemoTarget: Boolean(r.is_demo_target), storyIds: ids,
        verifiedCount: ids.filter(isVerified).length
      };
    });

    var project = plan.project || {};
    return {
      project: {
        name: project.name || plan.project_name || "",
        descriptor: project.descriptor || plan.descriptor || "",
        repoUrl: project.repo_url || null
      },
      schedule: plan.schedule || {},
      releases: releases,
      totals: progress.totals || null,
      stories: stories,
      requirements: requirements,
      guardrails: guardrails,
      roles: rolesWithStories(derived.roles || [], stories),
      measures: derived.measures || [],
      systems: derived.systems || [],
      agents: plan.agents || [],
      owners: ownersOf(stories),
      dataModel: extras.dataModel || { entities: [] },
      notes: (extras.notes && extras.notes.entries) || [],
      generatedAt: manifest.generated_at || null,
      isSample: false
    };
  }

  // Positive = the due date moved later than first given.
  function slipDays(baseline, due) {
    if (!baseline || !due) return null;
    return Math.round((Date.parse(due) - Date.parse(baseline)) / DAY_MS);
  }

  // A role's stories are the ones whose narrative is written for it:
  // "As a <role>, ..." or "As an <role>, ...".
  function rolesWithStories(roles, stories) {
    return roles.map(function (role) {
      var prefix = new RegExp("^As an? " + role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      return {
        name: role,
        storyIds: stories.filter(function (s) { return prefix.test(s.narrative || ""); })
          .map(function (s) { return s.id; })
      };
    });
  }

  // Story owners, grouped from the plan. These are people or teams named
  // on stories - NOT a scoped AI agent roster, and the page says so.
  function ownersOf(stories) {
    var byName = {};
    var order = [];
    stories.forEach(function (s) {
      var name = s.owner || "Unassigned";
      if (!byName[name]) { byName[name] = []; order.push(name); }
      byName[name].push(s.id);
    });
    return order.map(function (name) { return { name: name, storyIds: byName[name] }; });
  }

  // ---- Freshness -----------------------------------------------------
  // "Data as of", never "last synced": the stamp moves when the DATA
  // changes, so an old stamp means either nothing happened or nobody
  // synced. The page cannot tell which and prompts a sync either way.
  function dataAge(generatedAt, now) {
    var t = generatedAt ? Date.parse(generatedAt) : NaN;
    if (isNaN(t)) {
      return { level: "unknown", text: "Data as of: unknown - manifest.json has no generated_at", days: null };
    }
    var days = Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
    var absolute = new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    var relative = days === 0 ? "today" : days === 1 ? "1 day ago" : days + " days ago";
    var level = days > STALE_AFTER_DAYS ? "stale" : days >= 1 ? "aging" : "fresh";
    var text = "Data as of " + absolute + " (" + relative + ")";
    if (level === "stale") text += " - over a week old, sync from the portal to refresh";
    return { level: level, text: text, days: days };
  }

  // ---- Where in the term are we? --------------------------------------
  function phaseOf(schedule, releases, todayISO) {
    var current = null, next = null;
    releases.forEach(function (r) {
      if (!r.startsOn || !r.endsOn) return;
      if (todayISO >= r.startsOn && todayISO <= r.endsOn) current = r;
      if (!next && todayISO < r.startsOn) next = r;
    });
    if (current) return { kind: "release", release: current };
    if (schedule.build_start && todayISO < schedule.build_start) return { kind: "before", next: next };
    if (schedule.build_end && todayISO > schedule.build_end) {
      if (schedule.demo_day && todayISO <= schedule.demo_day) return { kind: "demo_prep" };
      return { kind: "after" };
    }
    return { kind: "between", next: next };
  }

  // ---- Sample mode ------------------------------------------------------
  // The real model's SHAPE with made-up values, so empty tabs show what
  // they will look like. Every invented value carries "(sample)" in its
  // text, and the page shows a SAMPLE banner and tags on top of that.
  function sampleModel(real) {
    var s = JSON.parse(JSON.stringify(real));
    s.isSample = true;
    var states = ["verified", "verified", "in_progress", "submitted", "not_started"];
    s.stories.forEach(function (story, i) {
      story.state = states[i % states.length];
      story.criteriaPassed = story.state === "verified" ? story.criteriaTotal : 0;
    });
    var verified = s.stories.filter(function (x) { return x.state === "verified"; }).length;
    s.totals = {
      stories_total: s.stories.length, stories_verified: verified,
      stories_submitted: 0, stories_in_progress: 0, stories_not_started: 0,
      criteria_total: s.stories.length * 3, criteria_passed: verified * 3,
      points_awarded: verified * 40
    };
    s.guardrails.forEach(function (g, i) { g.kept = i === 0; });
    s.measures = [
      { id: "MEASURE-S1", statement: "(sample) Advisor proposal turnaround under 30 minutes" },
      { id: "MEASURE-S2", statement: "(sample) 60% of customers manage their trip in the portal" }
    ];
    s.systems = ["(sample) Accounting software", "(sample) Payment processor", "(sample) Flight inventory"];
    return s;
  }

  return {
    load: load,
    buildModel: buildModel,
    dataAge: dataAge,
    phaseOf: phaseOf,
    sampleModel: sampleModel,
    STALE_AFTER_DAYS: STALE_AFTER_DAYS
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CCData;

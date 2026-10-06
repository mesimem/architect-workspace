// STORY-000: the Command Center's data layer. The page itself is static
// HTML; what can go wrong is the join, the freshness stamp and the
// sample overlay, and those are pure functions tested here against the
// real .colaberry files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CCData = require('../command-center/assets/data.js');

const root = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const plan = read('.colaberry/plan.json');
const progress = read('.colaberry/progress.json');
const manifest = read('.colaberry/manifest.json');

// ---- The join: state comes from progress, never from plan ----------
const model = CCData.buildModel(plan, progress, manifest);
assert.strictEqual(model.stories.length, plan.stories.length, 'every plan story is on the page');
assert.strictEqual(model.project.name, plan.project.name, 'project name read from plan.json');
assert.deepStrictEqual(model.totals, progress.totals, 'headline totals taken as-is, not recomputed');
assert.strictEqual(model.generatedAt, manifest.generated_at, 'data-as-of read from manifest.json');

const p4 = progress.stories.find((s) => s.id === 'STORY-004');
assert.strictEqual(model.stories.find((s) => s.id === 'STORY-004').state, p4.verification.state,
  'story state joined from progress.json on id');

// A plan story with no progress entry is "not checked yet" (null), never 0.
const planOnly = { ...plan, stories: [...plan.stories, { id: 'STORY-999', title: 'x', release: 'r0', acceptance: ['a', 'b'] }] };
const untracked = CCData.buildModel(planOnly, progress, manifest).stories.find((s) => s.id === 'STORY-999');
assert.strictEqual(untracked.state, null, 'absent verification reads as not checked');
assert.strictEqual(untracked.criteriaPassed, null, 'absent verification is not zero passed');
assert.strictEqual(untracked.criteriaTotal, 2, 'total falls back to the acceptance list');
console.log('commandCenter: plan and progress join on story id');

// Deleting a story from the plan removes it from the page.
const removed = CCData.buildModel({ ...plan, stories: plan.stories.filter((s) => s.id !== 'STORY-002') }, progress, manifest);
assert.ok(!removed.stories.some((s) => s.id === 'STORY-002'), 'a story deleted from the plan disappears');
console.log('commandCenter: a story deleted from the plan leaves the page');

// ---- Guardrails: kept only when every fulfilling story is verified --
for (const g of model.guardrails) {
  const req = plan.requirements.find((r) => r.id === g.id);
  const expected = req.fulfilled_by.length > 0 && req.fulfilled_by.every((id) => {
    const p = progress.stories.find((s) => s.id === id);
    return p && p.verification && p.verification.state === 'verified';
  });
  assert.strictEqual(g.kept, expected, g.id + ' kept iff its stories are verified');
}
const unverified = JSON.parse(JSON.stringify(progress));
unverified.stories.forEach((s) => { if (s.verification) s.verification.state = 'in_progress'; });
assert.ok(CCData.buildModel(plan, unverified, manifest).guardrails.every((g) => !g.kept),
  'no verified story means no guardrail is kept');
console.log('commandCenter: guardrails are kept only by verified stories');

// ---- Freshness stamp ----------------------------------------------
const at = '2026-10-01T12:00:00.000Z';
const fresh = CCData.dataAge(at, new Date('2026-10-01T18:00:00Z'));
assert.strictEqual(fresh.level, 'fresh');
assert.ok(/^Data as of 1 October 2026 \(today\)$/.test(fresh.text), 'absolute date and relative age: ' + fresh.text);
const aging = CCData.dataAge(at, new Date('2026-10-04T12:00:00Z'));
assert.strictEqual(aging.level, 'aging');
assert.ok(aging.text.includes('3 days ago'));
assert.strictEqual(CCData.dataAge(at, new Date('2026-10-08T12:00:00Z')).level, 'aging', 'exactly 7 days is not yet stale');
const stale = CCData.dataAge(at, new Date('2026-10-09T12:00:00Z'));
assert.strictEqual(stale.level, 'stale', 'over a week old warns');
assert.ok(stale.text.includes('sync from the portal to refresh'));
assert.strictEqual(CCData.dataAge(null, new Date()).level, 'unknown', 'missing generated_at is unknown, not fresh');
assert.strictEqual(CCData.dataAge('not a date', new Date()).level, 'unknown');
console.log('commandCenter: data-as-of stamp ages and warns after a week');

// ---- Where in the term ----------------------------------------------
const s = plan.schedule;
const r0 = model.releases[0];
assert.strictEqual(CCData.phaseOf(s, model.releases, r0.startsOn).kind, 'release');
assert.strictEqual(CCData.phaseOf(s, model.releases, r0.startsOn).release.key, r0.key);
assert.strictEqual(CCData.phaseOf(s, model.releases, '2000-01-01').kind, 'before');
assert.strictEqual(CCData.phaseOf(s, model.releases, s.demo_day).kind, 'demo_prep');
assert.strictEqual(CCData.phaseOf(s, model.releases, '2099-01-01').kind, 'after');
assert.strictEqual(CCData.phaseOf({}, [], '2026-01-01').kind, 'between', 'empty schedule does not throw');
console.log('commandCenter: phase of the term derived from the schedule');

// ---- Sample mode is labelled and never touches the real model ------
const before = JSON.stringify(model);
const sample = CCData.sampleModel(model);
assert.strictEqual(sample.isSample, true);
assert.strictEqual(JSON.stringify(model), before, 'building sample data does not mutate the real model');
assert.ok(sample.systems.length > 0 && sample.systems.every((x) => x.includes('(sample)')), 'sample systems labelled');
assert.ok(sample.measures.every((m) => m.statement.includes('(sample)')), 'sample measures labelled');
console.log('commandCenter: sample data is labelled and separate from real data');

// ---- Derived views: roles, owners, releases, slippage ---------------
const dataModel = read('command-center/data-model.json');
const notes = read('command-center/kb-notes.json');
const full = CCData.buildModel(plan, progress, manifest, { dataModel, notes });
assert.strictEqual(full.roles.length, plan.derived.roles.length, 'one entry per role in the plan');
for (const role of full.roles) {
  for (const id of role.storyIds) {
    const narrative = plan.stories.find((st) => st.id === id).narrative;
    assert.ok(new RegExp('^As an? ' + role.name + '\\b', 'i').test(narrative), id + ' is written for ' + role.name);
  }
}
assert.ok(!full.roles.find((r) => r.name === 'admin').storyIds.includes('STORY-012'), 'a role name inside another is not matched');
assert.strictEqual(full.owners.reduce((n, o) => n + o.storyIds.length, 0), plan.stories.length, 'every story has exactly one owner card');
const slipped = plan.stories.find((st) => st.due_on && st.due_baseline_on && st.due_on !== st.due_baseline_on);
if (slipped) {
  assert.notStrictEqual(full.stories.find((st) => st.id === slipped.id).slipDays, 0, 'a moved due date shows as slippage');
}
for (const r of full.releases) {
  const expected = r.storyIds.filter((id) => full.stories.find((st) => st.id === id && st.state === 'verified')).length;
  assert.strictEqual(r.verifiedCount, expected, r.key + ' verified count from progress');
}
assert.strictEqual(full.notes.length, notes.entries.length, 'knowledge-base notes loaded');
console.log('commandCenter: roles, owners, releases and slippage derived from the plan');

// ---- The data model names real stores and real stories ---------------
const backendStores = new Set();
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/createJsonFileStore\("([a-z-]+)"/g)) backendStores.add(m[1]);
    }
  }
})(path.join(root, 'backend', 'src'));
for (const e of dataModel.entities) {
  assert.ok(backendStores.has(e.store), e.store + ' is a store the backend really creates');
  assert.ok(fs.existsSync(path.join(root, e.source)), e.source + ' exists');
  assert.ok(e.fields.length > 0, e.store + ' lists its fields');
  // A store may cite a story built outside the platform's plan (STORY-017/018
  // were), so the citation must resolve to the plan OR to a story doc.
  for (const id of e.stories) {
    assert.ok(plan.stories.some((st) => st.id === id) || fs.existsSync(path.join(root, 'docs', 'stories', id + '.md')),
      e.store + ' cites ' + id + ', which is in the plan or documented');
  }
  for (const r of e.relationships) assert.ok(dataModel.entities.some((x) => x.store === r.references), e.store + ' references a modelled store');
}
for (const store of backendStores) {
  assert.ok(dataModel.entities.some((e) => e.store === store), 'backend store ' + store + ' is in the data model');
}
console.log('commandCenter: the data model matches the stores the backend creates');

// ---- Knowledge-base chat answers from the data, or says it cannot ----
const KbChat = require('../command-center/assets/kbChat.js');
const verifiedStory = full.stories.find((st) => st.state === 'verified');
const a1 = KbChat.answer('what about ' + verifiedStory.id.toLowerCase() + '?', full);
assert.ok(a1.text.includes(verifiedStory.title) && a1.text.includes('verified'), 'story answer from the data');
assert.strictEqual(a1.cite.href, 'pm.html', 'story answer cites its tab');
const anyReq = full.requirements[0];
assert.ok(KbChat.answer(anyReq.id, full).text.includes(anyReq.statement), 'requirement answer quotes the plan');
const t = progress.totals;
assert.ok(KbChat.answer('how many stories are done', full).text.startsWith(t.stories_verified + ' of ' + t.stories_total), 'progress from totals');
assert.strictEqual(KbChat.answer('which guardrails are kept', full).tab, 'guardrails');
assert.strictEqual(KbChat.answer('what is not built yet', full).tab, 'kb');
assert.ok(KbChat.answer('STORY-999', full).text.includes('not in the plan'), 'unknown story is not invented');
const unknown = KbChat.answer('what is the weather in Nairobi', full);
assert.ok(unknown.text.startsWith("I can't answer that"), 'no guessing outside the data');
assert.ok(KbChat.answer('', full).text.length > 0, 'empty question gets help, not an error');
console.log('commandCenter: knowledge-base chat answers from the data and cites the tab');

// ---- Every tab is a real page --------------------------------------
const siteText = fs.readFileSync(path.join(root, 'command-center/assets/site.js'), 'utf8');
const hrefs = [...siteText.matchAll(/href: "([a-z-]+\.html)"/g)].map((m) => m[1]);
assert.strictEqual(hrefs.length, 9, 'nine tabs');
for (const href of hrefs) assert.ok(fs.existsSync(path.join(root, 'command-center', href)), href + ' exists');
assert.ok(!/built: false/.test(siteText.replace(/`built: false`/g, '')), 'no tab left unbuilt');
assert.ok(fs.existsSync(path.join(root, 'index.html')), 'entry point at the repo root');
assert.ok(fs.existsSync(path.join(root, '.nojekyll')), '.nojekyll so GitHub Pages serves .colaberry/');
console.log('commandCenter: all nine tabs exist and are built');

// ---- No project content hard-coded into the page --------------------
const sources = ['command-center/assets/data.js', 'command-center/assets/site.js', 'command-center/assets/detail.js',
  'command-center/assets/kbChat.js', 'command-center/detail.html', 'command-center/kb-notes.json']
  .concat(hrefs.map((h) => 'command-center/' + h));
for (const file of sources) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const needle of [plan.project.name, 'STORY-0', 'REQ-0', 'African']) {
    assert.ok(!text.includes(needle), file + ' must not hard-code "' + needle + '"');
  }
}
console.log('commandCenter: no plan content hard-coded into the page');

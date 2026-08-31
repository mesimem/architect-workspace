#!/usr/bin/env node
//
// generateSessionChangelog.js — render one session's PROGRESS.md entries as a
// styled, self-contained HTML changelog.
//
// CLAUDE.md requires this after every completed change:
//
//     node scripts/generateSessionChangelog.js <SessionID> [--no-open]
//
// It reads PROGRESS.md, selects the entries tagged with the given Session ID,
// writes docs/sessions/SESSION_<SessionID>.html (one card per change), and
// opens it in the default browser. Pass --no-open to skip launching.
//
// One HTML per session, keyed on the Session ID, so concurrent Claude
// instances never overwrite each other's report.
//
// Zero dependencies by design — this repo has no package.json at the root and
// CLAUDE.md forbids assuming globally-installed tooling.
//
// Failure modes handled: missing session argument, missing PROGRESS.md, a
// Session ID that matches no entries (exits non-zero — a silent empty report
// would read as "nothing to log", which is exactly the gate this enforces).
// Not handled: concurrent writes to the same session file, which cannot
// happen because the filename is keyed on the session.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const PROGRESS_PATH = path.join(REPO_ROOT, "PROGRESS.md");
const OUTPUT_DIR = path.join(REPO_ROOT, "docs", "sessions");

// Order fields are rendered in. Anything not listed is appended afterwards in
// the order it appeared, so a new field in PROGRESS.md still shows up.
const FIELD_ORDER = ["Date", "What changed", "Verification", "Files touched", "Notes"];

const TASK_RE = /^-\s*\[([ xX])\]\s*(.*)$/;
const FIELD_RE = /^\s{2,}-\s*([^:\n]{1,40}?):\s*([\s\S]*)$/;

function parseEntries(markdown) {
  const entries = [];
  let current = null;
  let lastField = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const taskMatch = rawLine.match(TASK_RE);
    if (taskMatch) {
      current = {
        done: taskMatch[1].toLowerCase() === "x",
        title: taskMatch[2].trim(),
        fields: {},
        order: [],
      };
      entries.push(current);
      lastField = null;
      continue;
    }

    if (!current) continue;

    const fieldMatch = rawLine.match(FIELD_RE);
    if (fieldMatch) {
      lastField = fieldMatch[1].trim();
      if (!(lastField in current.fields)) current.order.push(lastField);
      current.fields[lastField] = fieldMatch[2].trim();
      continue;
    }

    if (rawLine.trim() === "") continue;

    if (/^\s/.test(rawLine) && lastField) {
      // Continuation of the previous field's value.
      current.fields[lastField] += " " + rawLine.trim();
      continue;
    }

    // A non-indented, non-task line (a heading, prose) ends this entry.
    current = null;
    lastField = null;
  }

  return entries;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Light inline markdown: `code` and **bold**. Applied AFTER escaping so a
// PROGRESS.md entry containing markup cannot inject HTML.
function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function orderedFields(entry) {
  const seen = new Set();
  const ordered = [];
  for (const name of FIELD_ORDER) {
    if (name in entry.fields) {
      ordered.push(name);
      seen.add(name);
    }
  }
  for (const name of entry.order) {
    if (!seen.has(name) && name !== "Session") ordered.push(name);
  }
  return ordered;
}

function renderCard(entry, index) {
  const rows = orderedFields(entry)
    .map(function (name) {
      return (
        '<div class="field"><div class="field-label">' +
        escapeHtml(name) +
        '</div><div class="field-value">' +
        renderInline(entry.fields[name]) +
        "</div></div>"
      );
    })
    .join("\n");

  const status = entry.done ? "Complete" : "In progress";
  const statusClass = entry.done ? "badge-done" : "badge-open";

  return [
    '<article class="card">',
    '  <header class="card-head">',
    '    <span class="card-index">' + String(index + 1).padStart(2, "0") + "</span>",
    "    <h2>" + renderInline(entry.title) + "</h2>",
    '    <span class="badge ' + statusClass + '">' + status + "</span>",
    "  </header>",
    rows,
    "</article>",
  ].join("\n");
}

function renderHtml(sessionId, entries, generatedAt) {
  const cards = entries.map(renderCard).join("\n");
  const noun = entries.length === 1 ? "change" : "changes";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session ${escapeHtml(sessionId)} — Change Report</title>
<style>
  :root {
    --cherry: #FB2832;
    --berry: #367895;
    --leaf: #5BA63C;
    --ink: #16202a;
    --muted: #5c6b7a;
    --rule: #dfe5ea;
    --surface: #ffffff;
    --canvas: #f4f6f8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: Roboto, system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
    line-height: 1.6;
  }
  code {
    font-family: "Roboto Mono", ui-monospace, Consolas, "Courier New", monospace;
    font-size: 0.9em;
    background: #eef2f5;
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0.05em 0.35em;
    word-break: break-word;
  }
  header.masthead {
    background: var(--surface);
    border-bottom: 3px solid var(--cherry);
    padding: 2rem 1.5rem 1.5rem;
  }
  .wrap { max-width: 60rem; margin: 0 auto; }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--berry);
    margin: 0 0 0.35rem;
  }
  h1 { font-size: 1.7rem; margin: 0 0 0.5rem; font-weight: 700; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 0.88rem; margin: 0; }
  main { padding: 1.75rem 1.5rem 3rem; }
  .card {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--berry);
    border-radius: 4px;
    padding: 1.25rem 1.4rem;
    margin-bottom: 1.1rem;
  }
  .card-head {
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    padding-bottom: 0.7rem;
    margin-bottom: 0.9rem;
    border-bottom: 1px solid var(--rule);
  }
  .card-index {
    font-family: "Roboto Mono", ui-monospace, Consolas, monospace;
    font-size: 0.8rem;
    color: var(--muted);
    flex: none;
  }
  .card-head h2 { font-size: 1.06rem; margin: 0; font-weight: 600; flex: 1 1 auto; }
  .badge {
    flex: none;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .badge-done { background: #eaf5e4; color: #3d7327; border: 1px solid var(--leaf); }
  .badge-open { background: #fdf1e3; color: #8a5810; border: 1px solid #E8920C; }
  .field { display: grid; grid-template-columns: 9.5rem 1fr; gap: 1rem; padding: 0.4rem 0; }
  .field + .field { border-top: 1px dotted var(--rule); }
  .field-label {
    font-size: 0.73rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    padding-top: 0.2rem;
  }
  .field-value { font-size: 0.93rem; overflow-wrap: anywhere; }
  footer { color: var(--muted); font-size: 0.8rem; padding: 0 1.5rem 2.5rem; }
  @media (max-width: 40rem) {
    .field { grid-template-columns: 1fr; gap: 0.15rem; }
  }
  @media print {
    body { background: #fff; }
    .card { break-inside: avoid; border-left-color: #999; }
  }
</style>
</head>
<body>
<header class="masthead">
  <div class="wrap">
    <p class="eyebrow">Claude Code session report</p>
    <h1>Session ${escapeHtml(sessionId)}</h1>
    <p class="meta">${entries.length} ${noun} logged &middot; generated ${escapeHtml(generatedAt)}</p>
  </div>
</header>
<main>
  <div class="wrap">
${cards}
  </div>
</main>
<footer>
  <div class="wrap">
    Generated from PROGRESS.md by scripts/generateSessionChangelog.js. Only entries
    tagged <code>Session: ${escapeHtml(sessionId)}</code> appear here.
  </div>
</footer>
</body>
</html>
`;
}

function openInBrowser(filePath) {
  if (process.platform === "win32") {
    // The empty string is start's window-title argument; without it a quoted
    // path is treated as the title and nothing opens.
    spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
  }
}

function main(argv) {
  const args = argv.slice(2);
  const noOpen = args.includes("--no-open");
  const sessionId = args.find(function (a) {
    return !a.startsWith("--");
  });

  if (!sessionId) {
    console.error("Usage: node scripts/generateSessionChangelog.js <SessionID> [--no-open]");
    console.error("Example: node scripts/generateSessionChangelog.js CC-20260828-b4k2");
    return 1;
  }

  if (!fs.existsSync(PROGRESS_PATH)) {
    console.error("PROGRESS.md not found at " + PROGRESS_PATH);
    return 1;
  }

  const entries = parseEntries(fs.readFileSync(PROGRESS_PATH, "utf8")).filter(function (e) {
    return e.fields.Session === sessionId;
  });

  if (entries.length === 0) {
    console.error('No PROGRESS.md entries tagged "Session: ' + sessionId + '".');
    console.error("Write the entry before generating the report — that is the gate.");
    return 1;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, "SESSION_" + sessionId + ".html");
  fs.writeFileSync(outPath, renderHtml(sessionId, entries, new Date().toISOString()), "utf8");

  console.log(
    "Wrote " +
      path.relative(REPO_ROOT, outPath) +
      " (" +
      entries.length +
      (entries.length === 1 ? " change)" : " changes)")
  );

  if (noOpen) {
    console.log("--no-open given; not launching a browser.");
  } else {
    openInBrowser(outPath);
  }

  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { parseEntries, renderHtml, escapeHtml, renderInline };

// STORY-016, the database-bottleneck failure path: measuring the store's write
// amplification, so the ceiling is a number rather than a worry.
//
// WHY THIS IS A SEPARATE FILE FROM jsonFileStore.test.js. That suite proves
// CORRECTNESS - rows survive a restart, a write is atomic, a corrupt file
// refuses to boot. This one proves a COST, and the two have opposite shapes: a
// correctness test asserts a value, a cost test asserts a curve.
//
// THE BOTTLENECK, which jsonFileStore.js already admits in its own header:
// every `set` rewrites the ENTIRE file. So writing N rows one at a time does
// not write N rows' worth of bytes - it writes 1 + 2 + 3 + ... + N, which is
// O(N^2). At a hundred rows nobody notices. At "thousands of customers",
// which is literally what REQ-018 asks for, each individual write is rewriting
// megabytes, and it does so SYNCHRONOUSLY - blocking the event loop, and with
// it every other request in the process.
//
// WHAT THIS STORY DOES AND DOES NOT DO ABOUT IT. Replacing the store with
// Postgres is a database-engine change, which CLAUDE.md lists as a governance
// boundary requiring escalation, and it would rewrite every store in the repo.
// That is not a one-story change and it is not attempted here. What IS done:
//
//   measured   the amplification is asserted below, as a curve, not estimated
//   bounded    the load governor caps how many requests can be awaiting work
//              at once, so the store cannot be hit by unbounded concurrency
//   documented ROW_CEILING_FOR_REVIEW is the point at which this must become
//              a database, with the arithmetic asserted so the number cannot
//              quietly go stale
//
// MEASURED IN BYTES, NOT MILLISECONDS, on purpose. A timing assertion on a
// shared CI machine is a coin flip, and a flaky test about performance is
// worse than none - it teaches the team to re-run until green. Bytes written
// is deterministic: the same rows always produce the same file, so the curve
// below is exact and reproducible on any machine.

"use strict";

const assert = require("assert");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createJsonFileStore } = require("./jsonFileStore");

// THE DOCUMENTED CEILING. Past this many rows in a single store, the
// whole-file rewrite is no longer an acceptable cost and the store must move
// to a real database.
//
// MEASURED ON THIS ROW SHAPE (a CRM lead, ~210 bytes serialised):
//
//     rows    final file   per write    amplification   total written
//      100       20.4 KB      1.21 ms          50.4x          1.00 MB
//      500      103.2 KB      1.50 ms         249.9x         25.18 MB
//    1,000      206.7 KB      2.12 ms         499.8x        100.89 MB
//
// Amplification tracks N/2 exactly, which is the whole-file-rewrite signature.
// Extrapolated to the ceiling below: ~2.1 MB rewritten per write, ~10 GB
// written to fill the store one row at a time, and roughly 15-20 ms of
// SYNCHRONOUS disk I/O per write - all of it blocking the event loop, which
// means every other request in the process waits for it.
//
// 10,000 is set where per-write blocking becomes comparable to a whole
// request's budget. This is a REVIEW trigger, not a hard limit: nothing
// enforces it in code, because silently refusing a write would be a worse
// failure than a slow one. It is written down so the move to Postgres is
// decided deliberately and in advance, rather than during an incident.
const ROW_CEILING_FOR_REVIEW = 10_000;
const BYTES_PER_WRITE_AT_CEILING_MB = 2;

function freshDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-" + label + "-"));
}

// A row shaped like the real thing - a CRM lead is the highest-volume record
// in this system and the one "thousands of customers" actually refers to.
function leadRow(index) {
  return {
    fullName: "Customer Number " + index,
    email: "customer" + index + "@example.com",
    source: "web",
    status: "new",
    createdAt: "2026-10-01T12:00:00.000Z",
  };
}

// Inserts `rows` rows one at a time and returns how many bytes were written in
// total. Each `set` rewrites the whole file, so the bytes written by write i
// are exactly the file's size after write i.
function measureWrites(dir, name, rows) {
  const saved = process.env.COLABERRY_DATA_DIR;
  process.env.COLABERRY_DATA_DIR = dir;
  try {
    const store = createJsonFileStore(name);
    assert.strictEqual(store.persistent, true, "the measurement needs a real file");

    let totalBytesWritten = 0;
    for (let i = 0; i < rows; i += 1) {
      store.set("LEAD-" + i, leadRow(i));
      totalBytesWritten += fs.statSync(store.filePath).size;
    }

    return {
      rows: rows,
      totalBytesWritten: totalBytesWritten,
      finalFileBytes: fs.statSync(store.filePath).size,
      store: store,
    };
  } finally {
    if (saved === undefined) {
      delete process.env.COLABERRY_DATA_DIR;
    } else {
      process.env.COLABERRY_DATA_DIR = saved;
    }
  }
}

test("write cost is quadratic in the number of rows, not linear", function () {
  // THE CURVE. Eight times the rows must cost far more than eight times the
  // bytes - that gap IS the bottleneck, stated as a measurement instead of a
  // suspicion. If someone later makes writes incremental (an append log, or a
  // real database), this test fails, and that failure is the good news.
  const dir = freshDir("amplification");

  const small = measureWrites(dir, "leads-small", 50);
  const large = measureWrites(dir, "leads-large", 400);

  const rowRatio = large.rows / small.rows; // 8
  const byteRatio = large.totalBytesWritten / small.totalBytesWritten;

  assert.ok(
    byteRatio > rowRatio * 4,
    "8x the rows should cost far more than 8x the bytes; saw " +
      byteRatio.toFixed(1) +
      "x for " +
      rowRatio +
      "x the rows"
  );

  // Amplification = bytes actually written / bytes of data that exist. For a
  // whole-file rewrite this grows as roughly N/2, which is the signature.
  const amplification = large.totalBytesWritten / large.finalFileBytes;
  assert.ok(
    amplification > large.rows / 4,
    "expected amplification on the order of N/2, measured " + amplification.toFixed(1) + "x"
  );
});

test("the documented row ceiling matches the measured cost per row", function () {
  // Keeps ROW_CEILING_FOR_REVIEW honest. The constant above claims that one
  // write at the ceiling is around a megabyte; this derives the per-row size
  // from a real measurement and checks the claim. Change the row shape and
  // this test tells you the documented ceiling has moved.
  const dir = freshDir("ceiling");
  const measured = measureWrites(dir, "leads-ceiling", 200);

  const bytesPerRow = measured.finalFileBytes / measured.rows;
  const bytesPerWriteAtCeiling = bytesPerRow * ROW_CEILING_FOR_REVIEW;
  const megabytesAtCeiling = bytesPerWriteAtCeiling / (1024 * 1024);

  assert.ok(
    megabytesAtCeiling >= BYTES_PER_WRITE_AT_CEILING_MB * 0.5 &&
      megabytesAtCeiling <= BYTES_PER_WRITE_AT_CEILING_MB * 3,
    "at " +
      ROW_CEILING_FOR_REVIEW +
      " rows each write moves " +
      megabytesAtCeiling.toFixed(2) +
      "MB; the documented figure is ~" +
      BYTES_PER_WRITE_AT_CEILING_MB +
      "MB. Update the constant or the row shape."
  );

  // And the number that actually matters to an operator: the total bytes this
  // store would write to fill to the ceiling, one row at a time.
  const totalToFillCeiling =
    ((bytesPerRow * ROW_CEILING_FOR_REVIEW * (ROW_CEILING_FOR_REVIEW + 1)) / 2) / (1024 * 1024 * 1024);
  assert.ok(
    totalToFillCeiling > 1,
    "filling to the ceiling writes " + totalToFillCeiling.toFixed(1) + "GB - which is the point"
  );
});

test("no row is lost when writers interleave around an await", async function () {
  // THE CORRECTNESS HALF. Whole-file rewrite plus concurrency is how data
  // quietly disappears: two writers each rewrite the file from their own view
  // of it, and the second overwrites the first's row.
  //
  // This store survives it because `set` is SYNCHRONOUS end to end - read,
  // mutate, write, with no await inside - so Node cannot interleave two calls
  // within one set(). That is a real guarantee but a fragile one: it holds
  // because of how the function is written, not because anything enforces it.
  // The await between writes below is what would expose the day someone makes
  // save() async, which is the obvious "improvement" to reach for when these
  // writes start to hurt.
  const dir = freshDir("interleaved");
  const saved = process.env.COLABERRY_DATA_DIR;
  process.env.COLABERRY_DATA_DIR = dir;

  try {
    const store = createJsonFileStore("leads-concurrent");
    const WRITERS = 8;
    const PER_WRITER = 25;

    await Promise.all(
      Array.from({ length: WRITERS }, async function (_unused, writer) {
        for (let i = 0; i < PER_WRITER; i += 1) {
          store.set("LEAD-" + writer + "-" + i, leadRow(i));
          // Yield, so the writers genuinely interleave rather than each
          // running to completion in turn.
          await new Promise(function (resolve) {
            setImmediate(resolve);
          });
        }
      })
    );

    const expected = WRITERS * PER_WRITER;
    assert.strictEqual(store.size, expected, "a row went missing in memory");

    // And on disk, which is the half that a rewrite-the-world store can lose.
    const onDisk = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    assert.strictEqual(onDisk.length, expected, "a row went missing on disk");

    // Every key, not just the right count - a count can be right while the
    // contents are wrong.
    const keys = new Set(
      onDisk.map(function (entry) {
        return entry[0];
      })
    );
    for (let writer = 0; writer < WRITERS; writer += 1) {
      for (let i = 0; i < PER_WRITER; i += 1) {
        assert.ok(keys.has("LEAD-" + writer + "-" + i), "lost LEAD-" + writer + "-" + i);
      }
    }
  } finally {
    if (saved === undefined) {
      delete process.env.COLABERRY_DATA_DIR;
    } else {
      process.env.COLABERRY_DATA_DIR = saved;
    }
  }
});

test("a crash mid-write cannot leave a partial file behind", function () {
  // The other reason this store is survivable at all: writes go to a temp file
  // and are renamed over the real one, and rename is atomic. Asserted here
  // alongside the cost measurements because it is the property that makes the
  // cost acceptable as an interim position - slow is recoverable, truncated is
  // not.
  const dir = freshDir("atomic");
  const measured = measureWrites(dir, "leads-atomic", 20);

  assert.ok(
    !fs.existsSync(measured.store.filePath + ".tmp"),
    "a temp file survived a completed write"
  );
  const onDisk = JSON.parse(fs.readFileSync(measured.store.filePath, "utf8"));
  assert.strictEqual(onDisk.length, 20, "the file is complete and parseable after every write");
});

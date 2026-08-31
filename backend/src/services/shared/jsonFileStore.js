// A keyed store that survives a process restart, with no dependencies.
//
// WHY THIS EXISTS. Every audit trail in this repo was a `new Map()`, so the
// advisor review queue, the African-section interaction log and the CRM
// transaction log all vanished on restart. The project guardrail is "the
// system must maintain audit logs for all transactions and changes", and a log
// that does not survive a restart does not maintain anything.
//
// CONFIGURED BY ENVIRONMENT, PER 12-FACTOR AND CLAUDE.md.
//   COLABERRY_DATA_DIR set   -> rows are persisted as JSON under that directory
//   COLABERRY_DATA_DIR unset -> pure in-memory, exactly the old behaviour
// Unset is the right default for development and for tests: a test suite that
// reads rows left behind by the previous run is not a test, it is a haunting.
// Production sets the variable.
//
// WRITES ARE ATOMIC. Each save writes a temporary file and renames it over the
// real one. A rename is atomic on both NTFS and POSIX, so a crash halfway
// through a write leaves the previous complete file, never a half-written one.
// The alternative - writing in place - can truncate an audit trail to nothing
// at exactly the moment something is going wrong, which is the worst possible
// time to lose it.
//
// A CORRUPT FILE IS FATAL ON PURPOSE. If the JSON will not parse we throw at
// startup rather than quietly starting with an empty log. Silently discarding
// an audit trail is a worse failure than refusing to boot, and the recovery is
// one command: move the file aside and restart.
//
// KNOWN LIMITS, deliberately not solved here:
//   - Writes are synchronous and rewrite the whole file. Fine for hundreds of
//     rows, wrong for hundreds of thousands. This is a bridge to Postgres, not
//     a replacement for it; the interface is Map-shaped precisely so that swap
//     touches this file only.
//   - No file locking, so two processes sharing a directory can lose a write.
//     Single-process today; the real fix is the database, same as everywhere
//     else in this repo.

const fs = require("fs");
const path = require("path");

class CorruptStoreError extends Error {
  constructor(filePath, cause) {
    super(
      "Could not read the store at " +
        filePath +
        " (" +
        (cause && cause.message ? cause.message : "unreadable") +
        "). Refusing to start with an empty audit trail. " +
        "Move the file aside to start fresh."
    );
    this.name = "CorruptStoreError";
    this.errorClass = "ContractViolation";
  }
}

function dataDir() {
  const configured = process.env.COLABERRY_DATA_DIR;
  return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : null;
}

function load(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new CorruptStoreError(filePath, error);
  }
  if (!Array.isArray(parsed)) {
    throw new CorruptStoreError(filePath, new Error("expected an array of [key, value] pairs"));
  }
  return new Map(parsed);
}

function save(filePath, entries) {
  const tempPath = filePath + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(Array.from(entries), null, 2), "utf8");
  fs.renameSync(tempPath, filePath); // atomic replace
}

// Map-shaped on purpose: the modules that use this were written against `new
// Map()` and should not have to care where their rows live.
function createJsonFileStore(name) {
  const dir = dataDir();

  if (!dir) {
    const memory = new Map();
    return {
      persistent: false,
      filePath: null,
      get: memory.get.bind(memory),
      set: function (key, value) {
        memory.set(key, value);
        return this;
      },
      has: memory.has.bind(memory),
      delete: memory.delete.bind(memory),
      keys: memory.keys.bind(memory),
      values: memory.values.bind(memory),
      // No-op: an in-memory row is already "saved". Present so callers can
      // flush unconditionally without knowing which mode they are in.
      flush: function () {},
      get size() {
        return memory.size;
      },
    };
  }

  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name + ".json");
  const rows = load(filePath);

  return {
    persistent: true,
    filePath: filePath,
    get: rows.get.bind(rows),
    has: rows.has.bind(rows),
    keys: rows.keys.bind(rows),
    values: rows.values.bind(rows),
    set: function (key, value) {
      rows.set(key, value);
      save(filePath, rows.entries());
      return this;
    },
    delete: function (key) {
      const existed = rows.delete(key);
      if (existed) {
        save(filePath, rows.entries());
      }
      return existed;
    },
    // Callers that mutate a stored object in place (rather than through set)
    // must say so, or the change lives only in memory until the next write.
    flush: function () {
      save(filePath, rows.entries());
    },
    get size() {
      return rows.size;
    },
  };
}

module.exports = { createJsonFileStore, CorruptStoreError };

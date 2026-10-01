#!/usr/bin/env node
// Stock the safari product book with the starting Kenya and Tanzania inventory.
//
//   COLABERRY_DATA_DIR=/opt/colaberry/data node scripts/seedSafariProducts.js
//   node scripts/seedSafariProducts.js --dry-run     -> validate, write nothing
//   node scripts/seedSafariProducts.js --ephemeral   -> seed an in-memory book
//
// The packages themselves live in backend/src/seeds/safariProductSeed.js. This
// file is only the runner: load them, write them, report what happened, and
// exit non-zero if anything was refused.
//
// WHY IT REFUSES TO RUN WITHOUT COLABERRY_DATA_DIR, which is the one thing
// worth knowing before using it. The product book is durable only when that
// variable is set; otherwise it is an in-memory store belonging to THIS
// process. Seeding it from a separate process would write twelve packages,
// print a cheerful summary, exit, and take the entire catalog with it - the
// worst kind of failure, because every line of output says it worked. So the
// unset case is refused with the reason spelled out rather than served. Pass
// --ephemeral if that is genuinely what you want (seeding inside a one-process
// demo, or a smoke test).
//
// SAFE TO RUN TWICE, AND INTENDED TO BE. Creates dedup on (name, country), so
// a second run creates nothing and reports every package as replayed. That is
// what makes this usable from a deploy step instead of being a thing somebody
// runs once by hand and is afraid to repeat.
//
// IT NEVER UPDATES. A package already in the book is left exactly as it is,
// even if the seed file has since changed - because a product manager's
// correction must not be silently reverted by a deploy script. Changing a
// seeded package after the fact is a PATCH, by a person, through the API.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Exit code 1, with every refused package
//     named and its problem list printed. A partial seed is reported as a
//     failure even though the good packages landed, because "most of the
//     catalog" is not a state anybody should discover later.
//  2. Will it retry? No, and it must not: every refusal here is a validation
//     fault in the seed file, fixed by editing it. Re-running after the fix is
//     a human decision and is safe.
//  3. Recovery path? Fix the data, run again. Already-landed packages replay
//     untouched and only the corrected one is created.
//  4. Handled: an unset data dir, a refused package, an unwritable store (the
//     underlying error propagates and takes the exit code with it). NOT
//     handled: removing a package that should no longer be sold (there is no
//     delete route - an unsold package is a status question), and updating one
//     that has drifted (see above).

const crypto = require("crypto");

const { SEED_PRODUCTS, seedSafariProducts } = require("../backend/src/seeds/safariProductSeed");
const {
  validateSafariProduct,
} = require("../backend/src/services/products/safariProductValidation");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ephemeral = args.includes("--ephemeral");

// Guidance to stderr, the summary to stdout, so the useful part can be
// captured without the prose around it.
function note(message) {
  process.stderr.write(message + "\n");
}

function say(message) {
  process.stdout.write(message + "\n");
}

function describeRefusal(refusal) {
  return (
    "  REFUSED  " + refusal.name + "  (" + refusal.reason + ")\n" +
    refusal.problems
      .map(function (problem) {
        return "           - " + problem;
      })
      .join("\n")
  );
}

// --dry-run goes through the validator directly rather than the store: the
// point is to check the data without writing anything, and the store's job is
// to write. Same validator either way, so a dry run that passes and a real run
// that fails is not a thing that can happen.
function runDryRun() {
  const problems = [];
  SEED_PRODUCTS.forEach(function (product) {
    // validateSafariProduct returns a bare array of problems - empty means
    // usable. Not a {problems} wrapper; getting that wrong here read as "every
    // package is fine" until it threw.
    const found = validateSafariProduct(product);
    if (found.length > 0) {
      problems.push({ name: product.name, reason: "invalid_product", problems: found });
    }
  });

  if (problems.length > 0) {
    note("Dry run FAILED: " + problems.length + " of " + SEED_PRODUCTS.length + " packages are invalid.");
    problems.forEach(function (refusal) {
      note(describeRefusal(refusal));
    });
    return 1;
  }

  say("Dry run OK: all " + SEED_PRODUCTS.length + " packages are valid. Nothing was written.");
  return 0;
}

function runSeed() {
  // One correlation id per RUN, with the store given a distinct id per package
  // derived from it (see the seed module). A single id shared across twelve
  // creates would leave an audit trail unable to tell them apart.
  const correlationId = "seed-safari-" + crypto.randomUUID();
  const result = seedSafariProducts({ correlationId: correlationId });

  say("Seeded the safari product book  (correlationId " + correlationId + ")");
  say("  created   " + result.created.length);
  say("  replayed  " + result.replayed.length + "   (already in the book, left untouched)");
  say("  refused   " + result.refused.length);

  if (result.refused.length > 0) {
    note("");
    note("Some packages were refused. The book is INCOMPLETE:");
    result.refused.forEach(function (refusal) {
      note(describeRefusal(refusal));
    });
    return 1;
  }
  return 0;
}

function main() {
  if (dryRun) {
    return runDryRun();
  }

  if (!process.env.COLABERRY_DATA_DIR && !ephemeral) {
    note("Refusing to seed: COLABERRY_DATA_DIR is not set.");
    note("");
    note("The product book is in-memory unless that variable points at a data");
    note("directory. Seeding from this process would write " + SEED_PRODUCTS.length + " packages into a");
    note("store that disappears when it exits - and every line of output would");
    note("say it worked.");
    note("");
    note("  COLABERRY_DATA_DIR=/path/to/data node scripts/seedSafariProducts.js");
    note("  node scripts/seedSafariProducts.js --dry-run     (validate only)");
    note("  node scripts/seedSafariProducts.js --ephemeral   (really do want in-memory)");
    return 1;
  }

  if (ephemeral && !process.env.COLABERRY_DATA_DIR) {
    note("Seeding an IN-MEMORY product book: nothing written here survives this process.");
  }

  return runSeed();
}

process.exit(main());

// STORY-013, the story's "proposal generation timeout" failure path.
//
// Split out of proposalStore.test.js when that file crossed CLAUDE.md's
// 500-line ceiling, along the same seam the code follows: the lifecycle suite
// next door proves a failed assembly leaves the DRAFT intact, and this one
// proves the boundary itself behaves - what is retried, what is not, and what
// happens when a dependency succeeds with the wrong shape.
//
// Nothing here waits on a real clock: the hanging stub is raced against a 20ms
// timeout, so the slowest case in this file is about 120ms.

const assert = require("assert");

const { assembleDetails, REASONS, FAILURE_MESSAGE } = require("./proposalAssembly");

function tripDetails() {
  return {
    title: "Ten days in Tanzania",
    lines: [{ label: "Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 }],
    currency: "USD",
  };
}

async function main() {
  // HAPPY PATH WITH NO ASSEMBLE AT ALL - the current production path. The
  // details the advisor submitted are the details we price, unchanged and not
  // copied.
  {
    const details = tripDetails();
    const result = await assembleDetails(details);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.details, details, "the identity function, not a clone");
    console.log("proposalAssembly: with no assemble step, the submitted details pass straight through");
  }

  // A SUCCESSFUL ASSEMBLY'S OUTPUT IS WHAT COMES BACK. Otherwise the hook would
  // be decorative - it would look wired up and change nothing.
  {
    const result = await assembleDetails(tripDetails(), {
      assemble: async function (details) {
        return { ...details, lines: details.lines.concat([{ label: "Park fees", unitCostCents: 5000, unitSellCents: 8000, quantity: 2 }]) };
      },
      timeoutMs: 50,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.details.lines.length, 2);
    console.log("proposalAssembly: what the assembly returns is what comes back");
  }

  // A TIMEOUT IS RETRIED, CAPPED. The call that never settles is the dangerous
  // shape: without the race it would hold the advisor's request open forever.
  {
    let calls = 0;
    const hangs = function () {
      calls += 1;
      return new Promise(function () {}); // never settles
    };
    const result = await assembleDetails(tripDetails(), { assemble: hangs, timeoutMs: 20, maxAttempts: 2 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, REASONS.GENERATION_TIMEOUT);
    assert.strictEqual(calls, 2, "one initial call plus one retry, and no more");
    console.log("proposalAssembly: an assembly that hangs times out and retries exactly once");
  }

  // THE CAP IS THE CALLER'S, and it is honoured rather than silently replaced
  // by the default.
  {
    let calls = 0;
    const hangs = function () {
      calls += 1;
      return new Promise(function () {});
    };
    await assembleDetails(tripDetails(), { assemble: hangs, timeoutMs: 20, maxAttempts: 3 });
    assert.strictEqual(calls, 3);
    console.log("proposalAssembly: the retry cap is the caller's to set");
  }

  // A THROW IS NOT RETRIED. A rejected credential or a malformed payload does
  // not fix itself, and retrying doubles the load on something already broken.
  {
    let calls = 0;
    const broken = async function () {
      calls += 1;
      throw new Error("catalog exploded: https://example.test/?token=abcd1234");
    };
    const result = await assembleDetails(tripDetails(), { assemble: broken, timeoutMs: 20, maxAttempts: 3 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, REASONS.GENERATION_UNAVAILABLE, "unavailable, not timeout");
    assert.strictEqual(calls, 1, "a throw is not retried");
    console.log("proposalAssembly: an assembly that throws fails fast, without a retry");
  }

  // THE UPSTREAM ERROR DOES NOT LEAK. An error message can carry a URL with a
  // token in it, and refusals reach responses and logs.
  {
    const result = await assembleDetails(tripDetails(), {
      assemble: async function () {
        throw new Error("catalog exploded: https://example.test/?token=abcd1234");
      },
      timeoutMs: 20,
    });
    const said = JSON.stringify(result.problems);
    assert.ok(!said.includes("abcd1234"), "no credential in the refusal");
    assert.ok(!said.includes("exploded"), "no upstream prose in the refusal either");
    assert.deepStrictEqual(result.problems, [FAILURE_MESSAGE]);
    // The one thing the advisor cannot see for themselves, and the only thing
    // they need: their work is still there.
    assert.ok(FAILURE_MESSAGE.includes("draft is untouched"));
    console.log("proposalAssembly: a refusal says the draft survived, and nothing about the upstream");
  }

  // SUCCESS WITH THE WRONG SHAPE IS A DEPENDENCY FAILURE, NOT THE ADVISOR'S
  // MISTAKE. This is the case a timeout test never catches: unchecked, the junk
  // flows into the pricer and surfaces as "incorrect trip details", blaming the
  // advisor for a broken upstream.
  {
    for (const junk of [null, undefined, "details", 42, [], true]) {
      const result = await assembleDetails(tripDetails(), {
        assemble: async function () {
          return junk;
        },
        timeoutMs: 20,
      });
      assert.strictEqual(result.ok, false, "refused: " + JSON.stringify(junk));
      assert.strictEqual(result.reason, REASONS.GENERATION_UNAVAILABLE);
    }
    console.log("proposalAssembly: an assembly that succeeds with the wrong shape reads as unavailable");
  }

  // A NON-FUNCTION `assemble` IS NOT A CRASH. It is the no-op path, because the
  // alternative - throwing on a misconfigured option - would take down a
  // completion that could have succeeded.
  {
    for (const notAFunction of [null, undefined, "assemble", {}, 7]) {
      const result = await assembleDetails(tripDetails(), { assemble: notAFunction });
      assert.strictEqual(result.ok, true, "no-op for: " + JSON.stringify(notAFunction));
    }
    console.log("proposalAssembly: a non-function assemble option is the no-op path, not an exception");
  }

  console.log("proposalAssembly: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

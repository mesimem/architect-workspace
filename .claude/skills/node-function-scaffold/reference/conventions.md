# src/weekN/ function conventions

Derived from the existing example: `src/week3/addNumbers.js` + `tests/addNumbers.test.js`. Follow this exactly — don't introduce a framework or pattern this repo doesn't already use.

## Source file

- Location: `src/week<N>/<functionName>.js`
- Plain CommonJS, no ES module syntax (`import`/`export`), no TypeScript, no external dependencies.
- One function per file, named with `camelCase`, matching the filename.
- Export as a named object, even for a single function:

```js
function <functionName>(<params>) {
  // logic
}

module.exports = { <functionName> };
```

## Test file

- Location: `tests/<functionName>.test.js` (flat directory — no subfolders, no mirroring of `week<N>`).
- No test framework is configured in this repo (no Jest/Mocha config, no `package.json` test runner). Tests use Node's built-in `assert` module directly:

```js
const assert = require('assert');
const { <functionName> } = require('../src/week<N>/<functionName>');

assert.strictEqual(<functionName>(<args>), <expected>, '<description of what this case proves>');
// ...more assertions...

console.log('<functionName>: all tests passed');
```

- Aim for 3-5 `assert.strictEqual` calls covering: one typical/happy-path case, one boundary or zero/empty case, and one case that would catch an off-by-one or sign error if the logic were wrong. Each assertion needs its own descriptive message string (third argument) — that message is what prints on failure, so it must say what property is being verified, not just restate the inputs.
- The file ends with a single `console.log` announcing all tests passed. There is no separate "PASS/FAIL" reporter — a thrown `AssertionError` from `assert.strictEqual` is what signals failure when the file is run directly.

## Running a test

There's no `npm test` script. Run the file directly:

```
node tests/<functionName>.test.js
```

Exit code 0 and the "all tests passed" line means success. A thrown `AssertionError` means failure — read the message string on the assertion that threw, not just the diff.

const assert = require('assert');
const { <FUNCTION_NAME> } = require('../src/<WEEK_DIR>/<FUNCTION_NAME>');

assert.strictEqual(<FUNCTION_NAME>(<HAPPY_PATH_ARGS>), <HAPPY_PATH_EXPECTED>, '<happy path description>');
assert.strictEqual(<FUNCTION_NAME>(<BOUNDARY_ARGS>), <BOUNDARY_EXPECTED>, '<boundary/edge case description>');
assert.strictEqual(<FUNCTION_NAME>(<SIGN_OR_OFFBYONE_ARGS>), <SIGN_OR_OFFBYONE_EXPECTED>, '<case that would catch a sign or off-by-one error>');

console.log('<FUNCTION_NAME>: all tests passed');

const assert = require('assert');
const { addNumbers } = require('../src/week3/addNumbers');

assert.strictEqual(addNumbers(2, 3), 5, 'positive integers should sum correctly');
assert.strictEqual(addNumbers(-4, 4), 0, 'negative and positive should sum correctly');
assert.strictEqual(addNumbers(0, 0), 0, 'zero plus zero should be zero');
assert.strictEqual(addNumbers(2.5, 0.5), 3, 'decimals should sum correctly');

console.log('addNumbers: all tests passed');

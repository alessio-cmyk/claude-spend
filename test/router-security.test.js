const test = require('node:test');
const assert = require('node:assert/strict');
const { generateUniqueDevId, sanitizeProjectTagsInput } = require('../src/team/router');

test('generateUniqueDevId appends numeric suffix when base is taken', () => {
  const allowlist = [{ devId: 'Alex' }, { devId: 'alex2' }];
  const devId = generateUniqueDevId('Alex Johnson', allowlist);
  assert.equal(devId, 'Alex3');
});

test('sanitizeProjectTagsInput filters dangerous and invalid entries', () => {
  const tags = {
    projectA: ' growth ',
    __proto__: 'polluted',
    constructor: 'x',
    alpha: '',
    beta: 42,
    gamma: 'core',
  };

  const safe = sanitizeProjectTagsInput(tags);
  assert.deepEqual(safe, { projectA: 'growth', gamma: 'core' });
});

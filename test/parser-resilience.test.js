const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSessionData } = require('../src/parser');

test('extractSessionData tolerates malformed user content blocks', () => {
  const entries = [
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: { bad: true } },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 42 }],
      },
    },
  ];

  const queries = extractSessionData(entries);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].userPrompt, null);
  assert.deepEqual(queries[0].tools, ['Read']);
});

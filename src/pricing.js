// Anthropic API pricing per token (USD), first-party standard rates.
// Cache writes are 1.25x base input for the 5-minute TTL and 2x for the 1-hour TTL.
// Cache reads are 0.1x base input unless the model says otherwise.
const M = 1e6;

function rates(input, output, cacheRead = input * 0.1) {
  return {
    input: input / M,
    output: output / M,
    cacheWrite5m: (input * 1.25) / M,
    cacheWrite1h: (input * 2) / M,
    cacheRead: cacheRead / M,
  };
}

const MODEL_PRICING = {
  'fable-5.1': rates(10, 50, 0.25),
  'fable-5': rates(10, 50),
  'opus-5.5': rates(4, 20, 0.20),
  'opus-5': rates(5, 25),
  // Opus 4.5 through 4.8: $5/MTok in, $25/MTok out
  'opus-4.5+': rates(5, 25),
  // Opus 4.0, 4.1, 3: $15/MTok in, $75/MTok out
  'opus-4.0': rates(15, 75),
  'sonnet-5': rates(2, 10),
  // Sonnet 3.7, 4, 4.5, 4.6
  sonnet: rates(3, 15),
  'haiku-4.5': rates(1, 5),
  'haiku-3.5': rates(0.80, 4),
};
const DEFAULT_PRICING = MODEL_PRICING.sonnet;

// Model IDs look like claude-opus-5, claude-opus-5-5, claude-opus-4-6-20260101, claude-3-opus-...
function versionOf(m, family) {
  // Version parts are 1-2 digits, so a date suffix (claude-3-opus-20240229) never parses as a version
  const match = m.match(new RegExp(family + '[-.](\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?'));
  if (!match) return null;
  return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
}

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  const m = model.toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) {
    const v = versionOf(m, m.includes('fable') ? 'fable' : 'mythos');
    return v && v.major === 5 && v.minor === 0 ? MODEL_PRICING['fable-5'] : MODEL_PRICING['fable-5.1'];
  }
  if (m.includes('opus')) {
    const v = versionOf(m, 'opus');
    if (!v) return MODEL_PRICING['opus-4.0']; // claude-3-opus
    if (v.major >= 5) return v.minor >= 5 ? MODEL_PRICING['opus-5.5'] : MODEL_PRICING['opus-5'];
    if (v.major === 4 && v.minor >= 5) return MODEL_PRICING['opus-4.5+'];
    return MODEL_PRICING['opus-4.0'];
  }
  if (m.includes('sonnet')) {
    const v = versionOf(m, 'sonnet');
    return v && v.major >= 5 ? MODEL_PRICING['sonnet-5'] : MODEL_PRICING.sonnet;
  }
  if (m.includes('haiku')) {
    const v = versionOf(m, 'haiku');
    return v && v.major === 4 && v.minor >= 5 ? MODEL_PRICING['haiku-4.5'] : MODEL_PRICING['haiku-3.5'];
  }
  return DEFAULT_PRICING;
}

// Cost of one query from its token fields. Queries recorded before the TTL split
// was tracked only have cacheCreationTokens; Claude Code writes almost all of its
// cache with the 1-hour TTL, so those are priced as 1-hour writes.
function queryCost(q) {
  const p = getPricing(q.model);
  const total5m = q.cacheCreation5mTokens;
  const total1h = q.cacheCreation1hTokens;
  const hasSplit = typeof total5m === 'number' || typeof total1h === 'number';
  const write5m = hasSplit ? (total5m || 0) : 0;
  const write1h = hasSplit ? (total1h || 0) : (q.cacheCreationTokens || 0);
  const cost = (q.inputTokens || 0) * p.input
    + write5m * p.cacheWrite5m
    + write1h * p.cacheWrite1h
    + (q.cacheReadTokens || 0) * p.cacheRead
    + (q.outputTokens || 0) * p.output;
  // Fast mode is billed at 2x standard rates
  return q.speed === 'fast' ? cost * 2 : cost;
}

module.exports = { MODEL_PRICING, getPricing, queryCost };

/**
 * AI-powered developer performance review using Gemini via Vertex AI.
 * Auth: GOOGLE_CREDENTIALS_BASE64 (base64-encoded service account JSON).
 */
const { VertexAI } = require('@google-cloud/vertexai');

let _client = null;

function getClient() {
  if (_client) return _client;

  const credsB64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!credsB64) throw new Error('GOOGLE_CREDENTIALS_BASE64 not set');

  const creds = JSON.parse(Buffer.from(credsB64, 'base64').toString('utf-8'));
  const project = creds.project_id;
  if (!project) throw new Error('No project_id in credentials');

  _client = new VertexAI({
    project,
    location: process.env.VERTEX_LOCATION || 'europe-west4',
    googleAuthOptions: {
      credentials: creds,
    },
  });
  return _client;
}

/**
 * Build a session summary string for the AI prompt.
 * Includes first prompt, project, model, tools, cost, and query count.
 */
function formatSessionForPrompt(s, idx) {
  const proj = s.project ? s.project.split(/[-/]/).slice(-2).join('/') : 'unknown';
  const tools = s._tools ? Object.entries(s._tools).map(([t, c]) => `${t}(${c})`).join(', ') : '';
  const models = s._models ? Object.keys(s._models).join(', ') : (s.model || 'unknown');
  const prompt = (s.firstPrompt || '(no prompt)').substring(0, 150).replace(/[\x00-\x1f]/g, ' ');
  return `[${idx + 1}] ${s.date || 'unknown'} | ${proj} | ${models} | ${s.queryCount || 0}q | $${(s.cost || 0).toFixed(2)} | tools: ${tools || 'none'}
   Prompt: ${prompt}`;
}

async function generateDevReview(devMetrics, sessions, teamBaseline, devTimezone) {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: process.env.VERTEX_MODEL || 'gemini-2.5-flash',
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  });

  const d = devMetrics;
  const topProjects = Object.entries(d.projectUsage || {})
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 5)
    .map(([p, v]) => `${p.split(/[-/]/).pop() || p}: ${v.sessions} sessions, $${v.cost.toFixed(2)}`);

  const topTools = (d.topTools || []).slice(0, 8).map(t => `${t.tool} (${t.count}x)`);

  const models = Object.entries(d.modelUsage || {})
    .map(([m, v]) => `${m}: ${v.queries} queries, $${v.cost.toFixed(2)}`);

  // Include recent sessions with full context (prompts, tools, projects)
  const recentSessions = (sessions || [])
    .sort((a, b) => (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''))
    .slice(0, 30)
    .map(formatSessionForPrompt)
    .join('\n');

  // Compute prompt pattern analysis
  const prompts = (sessions || []).map(s => s.firstPrompt || '').filter(Boolean);
  const avgPromptLen = prompts.length ? Math.round(prompts.reduce((s, p) => s + p.length, 0) / prompts.length) : 0;
  const shortPrompts = prompts.filter(p => p.length < 20).length;
  const longPrompts = prompts.filter(p => p.length > 100).length;

  // Hourly usage pattern from timestamps (in dev's timezone)
  const hourlyBuckets = new Array(24).fill(0);
  for (const s of (sessions || [])) {
    if (s.timestamp) {
      let h;
      if (devTimezone) {
        try {
          h = parseInt(new Date(s.timestamp).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: devTimezone }), 10);
        } catch { h = new Date(s.timestamp).getHours(); }
      } else {
        h = new Date(s.timestamp).getHours();
      }
      if (h >= 0 && h < 24) hourlyBuckets[h]++;
    }
  }
  const peakHour = hourlyBuckets.indexOf(Math.max(...hourlyBuckets));
  const activeHours = hourlyBuckets.map((c, h) => c > 0 ? h : -1).filter(h => h >= 0);
  const earliestHour = activeHours.length > 0 ? Math.min(...activeHours) : null;
  const latestHour = activeHours.length > 0 ? Math.max(...activeHours) : null;
  const morningCount = hourlyBuckets.slice(6, 12).reduce((a, b) => a + b, 0);
  const afternoonCount = hourlyBuckets.slice(12, 18).reduce((a, b) => a + b, 0);
  const eveningCount = hourlyBuckets.slice(18, 24).reduce((a, b) => a + b, 0);
  const nightCount = hourlyBuckets.slice(0, 6).reduce((a, b) => a + b, 0);
  const totalTimestamped = morningCount + afternoonCount + eveningCount + nightCount;
  const hourlyDistStr = hourlyBuckets.map((c, h) => c > 0 ? `${h}:00=${c}` : '').filter(Boolean).join(', ');

  // Per-project session breakdown
  const projBreakdown = {};
  for (const s of (sessions || [])) {
    const p = s.project || 'unknown';
    if (!projBreakdown[p]) projBreakdown[p] = { sessions: 0, queries: 0, cost: 0, tools: new Set() };
    projBreakdown[p].sessions++;
    projBreakdown[p].queries += s.queryCount || 0;
    projBreakdown[p].cost += s.cost || 0;
    if (s._tools) Object.keys(s._tools).forEach(t => projBreakdown[p].tools.add(t));
  }
  const projDetail = Object.entries(projBreakdown)
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, 8)
    .map(([p, v]) => `${p.split(/[-/]/).slice(-2).join('/')}: ${v.sessions} sessions, ${v.queries} queries, $${v.cost.toFixed(2)}, tools: ${[...v.tools].slice(0, 5).join(',')||'none'}`)
    .join('\n');

  const prompt = `You are an engineering manager reviewing a developer's AI tool usage data.
Analyze this developer's Claude Code usage and write a concise, actionable performance review.
You have access to their FULL usage data including what they asked AI to do, which tools were invoked, and how they work across projects.

DEVELOPER: ${d.devId}

=== AGGREGATE METRICS ===
- Sessions: ${d.sessions} | Queries: ${d.queries} | Active Days: ${d.activeDays}
- Avg Queries/Session: ${d.avgQueriesPerSession} | Avg Session Depth: ${d.avgSessionDepth}
- Total Tokens: ${d.totalTokens.toLocaleString()} | Total Cost: $${d.cost.toFixed(2)}
- Tool Activation Rate: ${d.toolActivationRate}% | Unique Tools: ${d.uniqueTools}
- Cache Hit Rate: ${d.cacheHitRate.toFixed(1)}% | Output Ratio: ${d.outputRatio.toFixed(1)}%
- Current Streak: ${d.streak} days | Trend: ${d.trend > 0 ? '+' : ''}${d.trend}%
- Top Projects: ${topProjects.join(' | ') || 'None'}
- Top Tools: ${topTools.join(', ') || 'None'}
- Models Used: ${models.join(' | ') || 'None'}

=== TEAM BASELINE (${teamBaseline ? teamBaseline.teamSize + ' devs, comparing against ' + teamBaseline.otherDevs + ' peers' : 'no team data'}) ===
${teamBaseline ? `- Queries/Session: avg ${teamBaseline.queriesPerSession.avg} (range ${teamBaseline.queriesPerSession.min}–${teamBaseline.queriesPerSession.max}) — this dev: ${d.avgQueriesPerSession}
- Cost/Query: avg $${teamBaseline.costPerQuery.avg.toFixed(3)} (range $${teamBaseline.costPerQuery.min.toFixed(3)}–$${teamBaseline.costPerQuery.max.toFixed(3)}) — this dev: $${d.queries ? (d.cost / d.queries).toFixed(3) : '0'}
- Cache Hit Rate: avg ${teamBaseline.cacheHitRate.avg}% (range ${teamBaseline.cacheHitRate.min}–${teamBaseline.cacheHitRate.max}%) — this dev: ${d.cacheHitRate.toFixed(1)}%
- Tool Activation: avg ${teamBaseline.toolActivationRate.avg}% (range ${teamBaseline.toolActivationRate.min}–${teamBaseline.toolActivationRate.max}%) — this dev: ${d.toolActivationRate}%
- Output Ratio: avg ${teamBaseline.outputRatio.avg}% (range ${teamBaseline.outputRatio.min}–${teamBaseline.outputRatio.max}%) — this dev: ${d.outputRatio.toFixed(1)}%
- Unique Tools: avg ${teamBaseline.uniqueTools.avg} (range ${teamBaseline.uniqueTools.min}–${teamBaseline.uniqueTools.max}) — this dev: ${d.uniqueTools}
- Sessions: avg ${teamBaseline.sessions.avg} (range ${teamBaseline.sessions.min}–${teamBaseline.sessions.max}) — this dev: ${d.sessions}
- Active Days: avg ${teamBaseline.activeDays.avg} (range ${teamBaseline.activeDays.min}–${teamBaseline.activeDays.max}) — this dev: ${d.activeDays}
- Health Score: avg ${teamBaseline.healthScore.avg} (range ${teamBaseline.healthScore.min}–${teamBaseline.healthScore.max}) — this dev: ${d.healthScore || 'N/A'}` : 'No team comparison data available.'}

=== PROMPT PATTERNS ===
- Total Prompts: ${prompts.length} | Avg Prompt Length: ${avgPromptLen} chars
- Short Prompts (<20 chars): ${shortPrompts} (${prompts.length ? Math.round(shortPrompts/prompts.length*100) : 0}%)
- Detailed Prompts (>100 chars): ${longPrompts} (${prompts.length ? Math.round(longPrompts/prompts.length*100) : 0}%)

=== DAILY USAGE PATTERN ===
${totalTimestamped > 0 ? `- Work Window: ${earliestHour !== null ? earliestHour + ':00' : '?'} – ${latestHour !== null ? latestHour + ':00' : '?'} | Peak Hour: ${peakHour}:00
- Morning (6-12): ${morningCount} sessions (${totalTimestamped ? Math.round(morningCount/totalTimestamped*100) : 0}%)
- Afternoon (12-18): ${afternoonCount} sessions (${totalTimestamped ? Math.round(afternoonCount/totalTimestamped*100) : 0}%)
- Evening (18-24): ${eveningCount} sessions (${totalTimestamped ? Math.round(eveningCount/totalTimestamped*100) : 0}%)
- Night (0-6): ${nightCount} sessions (${totalTimestamped ? Math.round(nightCount/totalTimestamped*100) : 0}%)
- Hourly detail: ${hourlyDistStr}` : 'No timestamp data available.'}

=== PROJECT BREAKDOWN ===
${projDetail || 'No project data'}

=== RECENT SESSIONS (most recent ${Math.min((sessions || []).length, 30)} of ${(sessions || []).length}) ===
${recentSessions || 'No session data'}

=== GRADING RUBRIC (BE STRICT — most devs should be B or C) ===
A = Exceptional: Top performer on the team. Above-average on most metrics, high prompt quality, diverse tool usage, strong consistency, efficient cost. Reserve A for devs who are clearly best-in-class.
B = Good: Above team average on several metrics, solid prompt quality, regular usage. Minor gaps in 1-2 areas.
C = Average: Near team averages, adequate usage but nothing stands out. Some clear areas for improvement. This is the DEFAULT grade — most devs should land here.
D = Below expectations: Below team average on multiple metrics, low session count or engagement, vague prompts, poor tool usage, or wasteful patterns.
F = Concerning: Minimal or no meaningful AI usage, far below team norms, or actively wasteful patterns.

Key grading signals:
- Sessions/Active Days below team average = penalize (not using the tool enough)
- Tool Activation below team average = penalize (not leveraging AI capabilities)
- Short vague prompts (>30% short prompts) = penalize (low-quality interactions)
- Low queries/session vs team = penalize (shallow sessions)
- Declining trend (negative %) = penalize
- Only 1 project = penalize (narrow usage)
- Cache hit rate well below team avg = penalize (inefficient)
- Usage concentrated in only 1-2 hours = penalize (not integrating AI throughout the workday)
- Night/weekend-heavy usage without daytime usage = flag (potential work-life balance concern)
- Grade relative to the TEAM, not in absolute terms. The best dev gets A, the worst gets D or F, the middle gets C.

=== ANALYSIS INSTRUCTIONS ===
1. Compare against team baseline: Where does this dev stand vs peers? Call out metrics above/below team average.
2. Assess prompt quality: Are they giving Claude clear, specific instructions or vague one-liners?
3. Evaluate tool usage patterns: Are they leveraging Claude's tool capabilities effectively?
4. Look at project diversity: Are they using AI across their work or only for specific tasks?
5. Check model selection: Are they using appropriate models for the task complexity?
6. Identify workflow patterns: session depth, frequency, cost efficiency relative to team
7. Analyze daily usage pattern: Do they use AI throughout the working day or only in bursts? A dev who integrates AI across their full work window is getting more value than one who uses it sporadically.
8. Note any concerning patterns: over-reliance, under-utilization, wasteful usage, falling behind team norms

Write a JSON response with this exact structure:
{
  "summary": "2-3 sentence overall assessment referencing their actual prompts and work patterns",
  "grade": "A/B/C/D/F — use the rubric above, be strict, most devs should be B or C",
  "strengths": ["strength 1", "strength 2", ...],
  "improvements": ["area 1", "area 2", ...],
  "recommendations": ["specific action 1", "specific action 2", ...],
  "prompt_quality": "excellent/good/fair/poor - based on prompt specificity and clarity",
  "efficiency_rating": "high/medium/low - based on cost-per-query and cache usage",
  "adoption_rating": "power-user/regular/occasional/minimal",
  "work_patterns": "brief description of how they use AI day-to-day based on session data",
  "risk_flags": ["any concerns like declining usage, vague prompts, no tool use, etc."]
}

Be specific and reference actual prompts, projects, and numbers from the data. Keep each bullet to 1 sentence. Return ONLY the JSON.`;

  const result = await model.generateContent(prompt);
  const text = result.response.candidates[0].content.parts[0].text.trim();

  // Strip markdown code fences if present
  let clean = text;
  if (clean.startsWith('```')) {
    clean = clean.split('```')[1];
    if (clean.startsWith('json')) clean = clean.slice(4);
    clean = clean.trim();
  }

  // Try progressively looser JSON parsing
  try {
    return JSON.parse(clean);
  } catch {
    // Extract the JSON object even if there's trailing garbage
    const braceMatch = clean.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch {}
    }
    // Fix common issue: truncated strings — close any open strings/arrays/objects
    let fixed = clean;
    // If truncated mid-string, close the string
    const openQuotes = (fixed.match(/"/g) || []).length;
    if (openQuotes % 2 !== 0) fixed += '"';
    // Close open arrays and objects
    const opens = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
    const braces = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
    for (let i = 0; i < opens; i++) fixed += ']';
    for (let i = 0; i < braces; i++) fixed += '}';
    try { return JSON.parse(fixed); } catch {}
    // Last resort: return a structured error
    return {
      summary: 'AI review generated but response could not be parsed.',
      grade: 'N/A',
      strengths: [],
      improvements: [],
      recommendations: ['Try generating the review again.'],
      prompt_quality: 'unknown',
      efficiency_rating: 'unknown',
      adoption_rating: 'unknown',
      work_patterns: '',
      risk_flags: ['Review parsing failed — raw response may have been truncated.'],
    };
  }
}

/**
 * Score a developer's prompt quality using Gemini.
 * Sends a sample of first prompts and gets back a 0-100 score.
 * Uses flash model for speed/cost since this is a lightweight analysis.
 */
async function scorePromptQuality(devId, prompts) {
  if (!prompts || prompts.length === 0) return { score: 0, rating: 'none', feedback: 'No prompts to analyze.' };

  const client = getClient();
  const model = client.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
  });

  // Sample up to 25 prompts to keep cost low
  const sample = prompts.length <= 25 ? prompts : prompts
    .sort(() => Math.random() - 0.5).slice(0, 25);

  // Sanitize prompts: escape quotes, remove control chars
  const sanitize = (s) => s.substring(0, 200).replace(/[\x00-\x1f]/g, ' ').replace(/"/g, '\\"');
  const numbered = sample.map((p, i) => `${i + 1}. "${sanitize(p)}"`).join('\n');

  const prompt = `You are evaluating the quality of prompts a developer gives to an AI coding assistant (Claude Code).

DEVELOPER: ${devId}
SAMPLE OF ${sample.length} SESSION-STARTING PROMPTS (out of ${prompts.length} total):

${numbered}

Score these prompts on a 0-100 scale based on:
- **Specificity** (20pts): Do prompts reference concrete files, functions, errors, or code? Or are they vague?
- **Clarity of intent** (20pts): Is the desired outcome clear? Does the dev say what they want done?
- **Context provided** (20pts): Do prompts include relevant constraints, expected behavior, or acceptance criteria?
- **Action orientation** (20pts): Do prompts use clear action verbs (fix, implement, refactor, debug, test)?
- **Efficiency** (20pts): Are prompts concise yet complete? Not too short (vague) or too long (rambling)?

Return ONLY a JSON object:
{
  "score": <0-100 integer>,
  "rating": "excellent|good|fair|poor",
  "feedback": "<1 sentence actionable advice for this developer to write better prompts>"
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.candidates[0].content.parts[0].text.trim();

  let clean = text;
  if (clean.startsWith('```')) {
    clean = clean.split('```')[1];
    if (clean.startsWith('json')) clean = clean.slice(4);
    clean = clean.trim();
  }

  // Try progressively looser JSON parsing
  try {
    return JSON.parse(clean);
  } catch {
    // Strip trailing garbage after the closing brace
    const braceMatch = clean.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch {}
    }
    // Last resort: extract fields with regex
    const scoreMatch = clean.match(/"score"\s*:\s*(\d+)/);
    const ratingMatch = clean.match(/"rating"\s*:\s*"(\w+)"/);
    const feedbackMatch = clean.match(/"feedback"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return {
      score: scoreMatch ? parseInt(scoreMatch[1]) : 50,
      rating: ratingMatch ? ratingMatch[1] : 'unknown',
      feedback: feedbackMatch ? feedbackMatch[1].replace(/\\"/g, '"') : 'Write specific prompts with file paths, expected behavior, and clear action verbs.',
    };
  }
}

// In-memory cache for prompt quality scores (keyed by devId + date range)
const _promptQualityCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getPromptQuality(devId, sessions) {
  const cacheKey = `${devId}:${sessions.length}`;
  const cached = _promptQualityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const prompts = sessions
    .map(s => s.firstPrompt || '')
    .filter(p => p.length > 0);

  const data = await scorePromptQuality(devId, prompts);
  _promptQualityCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

/**
 * Generate a "what I worked on" summary for performance review prep.
 * Input is compact session metadata plus per-session user prompts from the archive.
 */
// Vertex 429s (per-minute token quota) are transient — retry with backoff before failing
async function generateWithRetry(model, prompt, tries = 3) {
  let delay = 12000;
  for (let i = 0; i < tries; i++) {
    try {
      return await model.generateContent(prompt);
    } catch (e) {
      const is429 = /429|RESOURCE_EXHAUSTED/i.test(e.message || '');
      if (!is429 || i === tries - 1) throw e;
      console.log(`[work-summary] Vertex 429, retrying in ${delay / 1000}s (attempt ${i + 2}/${tries})`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

const WORK_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    period_summary: { type: 'string' },
    workstreams: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          project: { type: 'string' },
          period: { type: 'string' },
          sessions: { type: 'integer' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'bullets'],
      },
    },
    side_projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          project: { type: 'string' },
          period: { type: 'string' },
          sessions: { type: 'integer' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'bullets'],
      },
    },
    highlights: { type: 'array', items: { type: 'string' } },
    review_bullets: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['period_summary', 'workstreams', 'side_projects', 'highlights', 'review_bullets', 'gaps'],
};

async function generateWorkSummary(devId, sessions, promptsBySession, from, to) {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: process.env.VERTEX_MODEL || 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      // Constrained decoding — guarantees syntactically valid JSON matching the shape
      responseSchema: WORK_SUMMARY_SCHEMA,
      // Gemini 2.5 thinking tokens count against maxOutputTokens — cap them so big
      // session logs can't starve the actual JSON output
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  const sorted = [...sessions].sort((a, b) =>
    (a.timestamp || a.date || '').localeCompare(b.timestamp || b.date || ''));

  // Budget prompt detail by session count so a full quarter stays well under model limits
  const promptsPerSession = sorted.length > 300 ? 3 : sorted.length > 120 ? 5 : 8;
  const MAX_CHARS = 180000;

  const clean = (s) => s.substring(0, 150).replace(/[\x00-\x1f]/g, ' ');
  let totalChars = 0, dropped = 0;
  const lines = [];
  for (const s of sorted) {
    const proj = s.project ? s.project.split(/[-/]/).slice(-2).join('/') : 'unknown';
    let prompts = promptsBySession.get(s.sessionId) || [];
    if (prompts.length === 0 && s.firstPrompt) prompts = [s.firstPrompt];
    const promptStr = prompts.slice(0, promptsPerSession).map(clean).join(' ⏵ ') || '(no prompt)';
    const line = `${s.date || 'unknown'} | ${proj} | ${s.queryCount || 0}q | $${(s.cost || 0).toFixed(2)} | ${promptStr}`;
    if (totalChars + line.length > MAX_CHARS) { dropped++; continue; }
    totalChars += line.length;
    lines.push(line);
  }

  const company = process.env.COMPANY_CONTEXT || 'the company';
  const prompt = `You are helping a software developer prepare the self-assessment for their quarterly performance review at ${company}.
Below is a chronological log of their AI coding assistant sessions from ${from || 'the beginning'} to ${to || 'now'}: date, project, query count, cost, and the actual prompts they gave the assistant (separated by ⏵).

Reconstruct WHAT they worked on. Group related sessions into workstreams (a feature, a migration, a bug-fixing effort, a refactor). Write accomplishment-style bullets using strong verbs (Built, Fixed, Migrated, Designed, Debugged, Shipped).

RULES:
- Base everything ONLY on evidence in the prompts. Never invent features, metrics, or outcomes that aren't implied by the log.
- These are requests to an AI assistant, not proof of shipped work — phrase bullets as work done ("Built X", "Investigated Y"), but do not claim business impact or launch status unless the prompts state it.
- Ignore noise: slash commands (/model, /clear), greetings, one-word prompts like "continue" or "yes".
- Merge repeated sessions on the same topic into one workstream with a date range.
- If many sessions have vague prompts, list those projects under "gaps" so the developer knows to fill them in from memory.
- SEPARATE company work from personal side projects. Work related to ${company}'s product, codebase, infrastructure, or business goes in "workstreams". Clearly personal work — games, hobby tools, experiments, anything unrelated to the company's product (e.g. game engines, Discord bots, recipe apps) — goes in "side_projects" with the same structure. When genuinely unsure, default to "workstreams".
- "highlights" and "review_bullets" must ONLY cover company work — never include side projects there.

SESSIONS (${lines.length} of ${sorted.length}${dropped ? `, ${dropped} omitted for length` : ''}):
${lines.join('\n')}

Return ONLY a JSON object with this exact structure:
{
  "period_summary": "3-4 sentence overview of what this developer focused on during the period",
  "workstreams": [
    { "name": "short human-readable workstream name", "project": "project name", "period": "e.g. Apr 2 – May 10", "sessions": <number>, "bullets": ["accomplishment bullet", ...] }
  ],
  "side_projects": [
    { "name": "short name", "project": "project name", "period": "date range", "sessions": <number>, "bullets": ["what it is / what was done"] }
  ],
  "highlights": ["the 3-5 most significant COMPANY accomplishments"],
  "review_bullets": ["8-12 polished, paste-ready bullets for a performance review self-assessment — company work only"],
  "gaps": ["projects or periods the log can't explain well (vague prompts), which the developer should describe from memory"]
}`;

  const result = await generateWithRetry(model, prompt);
  const candidate = result.response.candidates[0];
  // Long responses can be split across multiple parts — join them all
  const text = candidate.content.parts.map(p => p.text || '').join('').trim();
  const finishReason = candidate.finishReason || 'UNKNOWN';

  let cleanText = text;
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.split('```')[1];
    if (cleanText.startsWith('json')) cleanText = cleanText.slice(4);
    cleanText = cleanText.trim();
  }
  let parseError = null;
  try {
    return JSON.parse(cleanText);
  } catch (e) {
    parseError = e.message;
    // Invalid escape sequences (e.g. a literal \d from a regex in a prompt) are the
    // most common breakage — escape any backslash not starting a valid JSON escape
    try { return JSON.parse(cleanText.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')); } catch {}
    const braceMatch = cleanText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch {}
    }
    let fixed = cleanText;
    const openQuotes = (fixed.match(/"/g) || []).length;
    if (openQuotes % 2 !== 0) fixed += '"';
    const opens = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
    const braces = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
    for (let i = 0; i < opens; i++) fixed += ']';
    for (let i = 0; i < braces; i++) fixed += '}';
    try { return JSON.parse(fixed); } catch {}
    console.error(`[work-summary] parse failed for ${devId}: finishReason=${finishReason} textLen=${text.length} error=${JSON.stringify(parseError)} tail=${JSON.stringify(text.slice(-120))}`);
    return {
      _parseFailed: true,
      period_summary: `Work summary could not be parsed (${finishReason === 'MAX_TOKENS' ? 'response was cut off — try a shorter date range' : 'malformed response — try again'}).`,
      workstreams: [], side_projects: [], highlights: [], review_bullets: [], gaps: [],
    };
  }
}

// In-memory cache for work summaries (keyed by devId + range + session count)
const _workSummaryCache = new Map();
const WORK_SUMMARY_TTL = 60 * 60 * 1000; // 1 hour

async function getWorkSummary(devId, sessions, promptsBySession, from, to) {
  const cacheKey = `${devId}:${from || ''}:${to || ''}:${sessions.length}`;
  const cached = _workSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WORK_SUMMARY_TTL) return cached.data;
  const data = await generateWorkSummary(devId, sessions, promptsBySession, from, to);
  // Never cache a failed parse — the next attempt should retry for real
  if (!data._parseFailed) _workSummaryCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

function isConfigured() {
  return !!process.env.GOOGLE_CREDENTIALS_BASE64;
}

module.exports = { generateDevReview, scorePromptQuality, getPromptQuality, getWorkSummary, isConfigured };

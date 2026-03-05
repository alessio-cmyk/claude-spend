const { loadAllDevelopers, filterSessions, computeTotals } = require('./store');

function getProductivityAnalytics(fromDate, toDate) {
  const allDevs = loadAllDevelopers();

  const devMetrics = [];
  const teamDaily = {};
  const teamModels = {};
  const teamTools = {};
  const teamProjects = {};

  for (const dev of allDevs) {
    const sessions = fromDate || toDate
      ? filterSessions(dev.sessions || [], fromDate, toDate)
      : (dev.sessions || []);

    if (sessions.length === 0) {
      devMetrics.push({
        devId: dev.devId, lastSync: dev.lastSync,
        sessions: 0, queries: 0, totalTokens: 0, outputTokens: 0, cost: 0,
        inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        avgTokensPerQuery: 0, avgQueriesPerSession: 0, avgSessionDepth: 0,
        outputRatio: 0, cacheHitRate: 0,
        activeDays: 0, streak: 0, trend: 0,
        toolActivationRate: 0, uniqueTools: 0, topTools: [],
        modelUsage: {}, projectUsage: {},
        dailyBreakdown: [],
      });
      continue;
    }

    const totals = computeTotals(sessions);
    const allQueries = sessions.flatMap(s => s.queries || []);

    // Daily breakdown
    const dailyMap = {};
    for (const s of sessions) {
      if (!s.date || s.date === 'unknown') continue;
      if (!dailyMap[s.date]) dailyMap[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0, outputTokens: 0 };
      dailyMap[s.date].tokens += s.totalTokens || 0;
      dailyMap[s.date].cost += s.cost || 0;
      dailyMap[s.date].sessions += 1;
      dailyMap[s.date].queries += s.queryCount || 0;
      dailyMap[s.date].outputTokens += s.outputTokens || 0;

      // Team daily
      if (!teamDaily[s.date]) teamDaily[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0, activeDevs: new Set() };
      teamDaily[s.date].tokens += s.totalTokens || 0;
      teamDaily[s.date].cost += s.cost || 0;
      teamDaily[s.date].sessions += 1;
      teamDaily[s.date].queries += s.queryCount || 0;
      teamDaily[s.date].activeDevs.add(dev.devId);
    }

    // Model usage
    const modelUsage = {};
    for (const q of allQueries) {
      if (!q.model || q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!modelUsage[q.model]) modelUsage[q.model] = { queries: 0, tokens: 0, cost: 0 };
      modelUsage[q.model].queries += 1;
      modelUsage[q.model].tokens += q.totalTokens || 0;
      modelUsage[q.model].cost += q.cost || 0;

      if (!teamModels[q.model]) teamModels[q.model] = { queries: 0, tokens: 0, cost: 0, devs: new Set() };
      teamModels[q.model].queries += 1;
      teamModels[q.model].tokens += q.totalTokens || 0;
      teamModels[q.model].cost += q.cost || 0;
      teamModels[q.model].devs.add(dev.devId);
    }

    // Tool usage
    const toolUsage = {};
    let sessionsWithTools = 0;
    for (const s of sessions) {
      let sessionHasTools = false;
      for (const q of (s.queries || [])) {
        for (const t of (q.tools || [])) {
          toolUsage[t] = (toolUsage[t] || 0) + 1;
          teamTools[t] = (teamTools[t] || 0) + 1;
          sessionHasTools = true;
        }
      }
      if (sessionHasTools) sessionsWithTools++;
    }

    // Project usage
    const projectUsage = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      if (!projectUsage[proj]) projectUsage[proj] = { sessions: 0, queries: 0, tokens: 0, cost: 0 };
      projectUsage[proj].sessions += 1;
      projectUsage[proj].queries += s.queryCount || 0;
      projectUsage[proj].tokens += s.totalTokens || 0;
      projectUsage[proj].cost += s.cost || 0;

      if (!teamProjects[proj]) teamProjects[proj] = { sessions: 0, queries: 0, tokens: 0, cost: 0, devs: new Set() };
      teamProjects[proj].sessions += 1;
      teamProjects[proj].queries += s.queryCount || 0;
      teamProjects[proj].tokens += s.totalTokens || 0;
      teamProjects[proj].cost += s.cost || 0;
      teamProjects[proj].devs.add(dev.devId);
    }

    // Session depth distribution
    const depths = sessions.map(s => s.queryCount || 0);
    const avgSessionDepth = depths.reduce((a, b) => a + b, 0) / depths.length;

    // Output ratio + cache hit rate
    const outputRatio = totals.totalTokens > 0 ? totals.totalOutputTokens / totals.totalTokens : 0;
    const totalInput = (totals.totalInputTokens || 0) + (totals.totalCacheReadTokens || 0) + (totals.totalCacheCreationTokens || 0);
    const cacheHitRate = totalInput > 0 ? (totals.totalCacheReadTokens || 0) / totalInput : 0;

    // Streak: consecutive active days ending at most recent day
    const sortedDays = Object.keys(dailyMap).sort();
    let streak = 0;
    if (sortedDays.length > 0) {
      streak = 1;
      for (let i = sortedDays.length - 1; i > 0; i--) {
        const curr = new Date(sortedDays[i]);
        const prev = new Date(sortedDays[i - 1]);
        const diffDays = (curr - prev) / 86400000;
        if (diffDays <= 1) streak++;
        else break;
      }
    }

    // Trend: compare first half vs second half query volume
    const sortedDaily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(sortedDaily.length / 2);
    const firstHalf = sortedDaily.slice(0, mid);
    const secondHalf = sortedDaily.slice(mid);
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((s, d) => s + d.queries, 0) / firstHalf.length : 0;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((s, d) => s + d.queries, 0) / secondHalf.length : 0;
    const trend = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg * 100) : 0;

    // Top tools sorted by count
    const topTools = Object.entries(toolUsage)
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([tool, count]) => ({ tool, count }));

    devMetrics.push({
      devId: dev.devId,
      lastSync: dev.lastSync,
      sessions: sessions.length,
      queries: totals.totalQueries,
      totalTokens: totals.totalTokens,
      inputTokens: totals.totalInputTokens,
      outputTokens: totals.totalOutputTokens,
      cacheReadTokens: totals.totalCacheReadTokens,
      cacheCreationTokens: totals.totalCacheCreationTokens,
      cost: totals.totalCost,
      avgTokensPerQuery: totals.totalQueries > 0 ? Math.round(totals.totalTokens / totals.totalQueries) : 0,
      avgQueriesPerSession: sessions.length > 0 ? Math.round(totals.totalQueries / sessions.length) : 0,
      avgSessionDepth: Math.round(avgSessionDepth),
      outputRatio: Math.round(outputRatio * 10000) / 100,
      cacheHitRate: Math.round(cacheHitRate * 10000) / 100,
      activeDays: Object.keys(dailyMap).length,
      streak,
      trend: Math.round(trend),
      toolActivationRate: sessions.length > 0 ? Math.round(sessionsWithTools / sessions.length * 100) : 0,
      uniqueTools: Object.keys(toolUsage).length,
      topTools,
      modelUsage,
      projectUsage,
      dailyBreakdown: sortedDaily,
    });
  }

  // Team aggregations
  const teamDailyArr = Object.values(teamDaily)
    .map(d => ({ ...d, activeDevs: d.activeDevs.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const teamModelArr = Object.entries(teamModels)
    .map(([model, v]) => ({ model, queries: v.queries, tokens: v.tokens, cost: v.cost, devCount: v.devs.size }))
    .sort((a, b) => b.tokens - a.tokens);

  const teamToolArr = Object.entries(teamTools)
    .sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([tool, count]) => ({ tool, count }));

  const teamProjectArr = Object.entries(teamProjects)
    .map(([project, v]) => ({ project, sessions: v.sessions, queries: v.queries, tokens: v.tokens, cost: v.cost, devCount: v.devs.size }))
    .sort((a, b) => b.tokens - a.tokens);

  // Team summary
  const activeDevs = devMetrics.filter(d => d.sessions > 0);
  const totalTokens = activeDevs.reduce((s, d) => s + d.totalTokens, 0);
  const totalCost = activeDevs.reduce((s, d) => s + d.cost, 0);
  const totalQueries = activeDevs.reduce((s, d) => s + d.queries, 0);
  const totalSessions = activeDevs.reduce((s, d) => s + d.sessions, 0);
  const totalOutputTokens = activeDevs.reduce((s, d) => s + d.outputTokens, 0);
  const totalCacheRead = activeDevs.reduce((s, d) => s + d.cacheReadTokens, 0);
  const totalInput = activeDevs.reduce((s, d) => s + d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens, 0);
  const activeDays = new Set(teamDailyArr.map(d => d.date)).size;

  return {
    team: {
      devCount: activeDevs.length,
      totalTokens, totalCost, totalQueries, totalSessions, totalOutputTokens,
      outputRatio: totalTokens > 0 ? Math.round(totalOutputTokens / totalTokens * 10000) / 100 : 0,
      cacheHitRate: totalInput > 0 ? Math.round(totalCacheRead / totalInput * 10000) / 100 : 0,
      activeDays,
      avgQueriesPerDay: activeDays > 0 ? Math.round(totalQueries / activeDays) : 0,
      avgCostPerDev: activeDevs.length > 0 ? Math.round(totalCost / activeDevs.length * 100) / 100 : 0,
    },
    developers: devMetrics.sort((a, b) => b.totalTokens - a.totalTokens),
    dailyTrend: teamDailyArr,
    modelBreakdown: teamModelArr,
    toolBreakdown: teamToolArr,
    projectBreakdown: teamProjectArr,
  };
}

module.exports = { getProductivityAnalytics };

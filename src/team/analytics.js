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

    // Daily breakdown
    const dailyMap = {};
    for (const s of sessions) {
      if (!s.date || s.date === 'unknown') continue;
      if (!dailyMap[s.date]) dailyMap[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      dailyMap[s.date].tokens += s.totalTokens || 0;
      dailyMap[s.date].cost += s.cost || 0;
      dailyMap[s.date].sessions += 1;
      dailyMap[s.date].queries += s.queryCount || 0;
      dailyMap[s.date].outputTokens += s.outputTokens || 0;
      dailyMap[s.date].inputTokens += s.inputTokens || 0;
      dailyMap[s.date].cacheReadTokens += s.cacheReadTokens || 0;
      dailyMap[s.date].cacheCreationTokens += s.cacheCreationTokens || 0;

      // Team daily
      if (!teamDaily[s.date]) teamDaily[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0, activeDevs: new Set(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      teamDaily[s.date].tokens += s.totalTokens || 0;
      teamDaily[s.date].cost += s.cost || 0;
      teamDaily[s.date].sessions += 1;
      teamDaily[s.date].queries += s.queryCount || 0;
      teamDaily[s.date].activeDevs.add(dev.devId);
      teamDaily[s.date].inputTokens += s.inputTokens || 0;
      teamDaily[s.date].outputTokens += s.outputTokens || 0;
      teamDaily[s.date].cacheReadTokens += s.cacheReadTokens || 0;
      teamDaily[s.date].cacheCreationTokens += s.cacheCreationTokens || 0;
    }

    // Model usage (from pre-aggregated _models or fallback to queries[])
    const modelUsage = {};
    for (const s of sessions) {
      const models = s._models || {};
      for (const [m, v] of Object.entries(models)) {
        if (!modelUsage[m]) modelUsage[m] = { queries: 0, tokens: 0, cost: 0 };
        modelUsage[m].queries += v.queries || 0;
        modelUsage[m].tokens += v.tokens || 0;
        modelUsage[m].cost += v.cost || 0;

        if (!teamModels[m]) teamModels[m] = { queries: 0, tokens: 0, cost: 0, devs: new Set() };
        teamModels[m].queries += v.queries || 0;
        teamModels[m].tokens += v.tokens || 0;
        teamModels[m].cost += v.cost || 0;
        teamModels[m].devs.add(dev.devId);
      }
    }

    // Tool usage (from pre-aggregated _tools or fallback to queries[])
    const toolUsage = {};
    let sessionsWithTools = 0;
    for (const s of sessions) {
      const tools = s._tools || {};
      const hasTools = s._hasToolCall !== undefined ? s._hasToolCall : Object.keys(tools).length > 0;
      for (const [t, count] of Object.entries(tools)) {
        toolUsage[t] = (toolUsage[t] || 0) + count;
        teamTools[t] = (teamTools[t] || 0) + count;
      }
      if (hasTools) sessionsWithTools++;
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
    // Weekends (Sat/Sun) don't break streaks — count them if active, skip if inactive
    const sortedDays = Object.keys(dailyMap).sort();
    let streak = 0;
    if (sortedDays.length > 0) {
      streak = 1;
      for (let i = sortedDays.length - 1; i > 0; i--) {
        const curr = new Date(sortedDays[i]);
        const prev = new Date(sortedDays[i - 1]);
        const diffDays = (curr - prev) / 86400000;
        if (diffDays <= 1) { streak++; }
        else {
          // Check if gap only contains weekend days
          let onlyWeekends = true;
          for (let d = 1; d < diffDays; d++) {
            const between = new Date(prev.getTime() + d * 86400000);
            const dow = between.getDay();
            if (dow !== 0 && dow !== 6) { onlyWeekends = false; break; }
          }
          if (onlyWeekends) streak++;
          else break;
        }
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

/* === FEATURE 2a: Week-over-Week Delta Computation === */
function getWeekOverWeekDeltas() {
  const allDevs = loadAllDevelopers();

  // Get current ISO week boundaries (Mon-Sun)
  const now = new Date();
  const dayOfWeek = now.getDay() || 7; // Mon=1..Sun=7
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - dayOfWeek + 1);
  thisMonday.setHours(0, 0, 0, 0);
  const thisSunday = new Date(thisMonday);
  thisSunday.setDate(thisMonday.getDate() + 6);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);

  const thisFrom = thisMonday.toISOString().split('T')[0];
  const thisTo = thisSunday.toISOString().split('T')[0];
  const lastFrom = lastMonday.toISOString().split('T')[0];
  const lastTo = lastSunday.toISOString().split('T')[0];

  function calcPct(current, previous) {
    if (previous === 0 && current > 0) return 100;
    if (previous === 0 && current === 0) return 0;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  const devDeltas = {};
  let teamThisQueries = 0, teamLastQueries = 0;
  let teamThisSessions = 0, teamLastSessions = 0;
  let teamThisCost = 0, teamLastCost = 0;
  let devsMoreActive = 0;

  for (const dev of allDevs) {
    const sessions = dev.sessions || [];
    const thisWeek = filterSessions(sessions, thisFrom, thisTo);
    const lastWeek = filterSessions(sessions, lastFrom, lastTo);

    const thisTotals = computeTotals(thisWeek);
    const lastTotals = computeTotals(lastWeek);

    // Cache hit rate
    const thisInput = (thisTotals.totalInputTokens || 0) + (thisTotals.totalCacheReadTokens || 0) + (thisTotals.totalCacheCreationTokens || 0);
    const lastInput = (lastTotals.totalInputTokens || 0) + (lastTotals.totalCacheReadTokens || 0) + (lastTotals.totalCacheCreationTokens || 0);
    const thisCacheRate = thisInput > 0 ? Math.round((thisTotals.totalCacheReadTokens || 0) / thisInput * 1000) / 10 : 0;
    const lastCacheRate = lastInput > 0 ? Math.round((lastTotals.totalCacheReadTokens || 0) / lastInput * 1000) / 10 : 0;

    devDeltas[dev.devId] = {
      queries: { current: thisTotals.totalQueries, previous: lastTotals.totalQueries, delta: thisTotals.totalQueries - lastTotals.totalQueries, pct: calcPct(thisTotals.totalQueries, lastTotals.totalQueries) },
      sessions: { current: thisTotals.totalSessions, previous: lastTotals.totalSessions, delta: thisTotals.totalSessions - lastTotals.totalSessions, pct: calcPct(thisTotals.totalSessions, lastTotals.totalSessions) },
      cost: { current: Math.round(thisTotals.totalCost * 100) / 100, previous: Math.round(lastTotals.totalCost * 100) / 100, delta: Math.round((thisTotals.totalCost - lastTotals.totalCost) * 100) / 100, pct: calcPct(thisTotals.totalCost, lastTotals.totalCost) },
      cacheHitRate: { current: thisCacheRate, previous: lastCacheRate, delta: Math.round((thisCacheRate - lastCacheRate) * 10) / 10, pct: calcPct(thisCacheRate, lastCacheRate) },
    };

    teamThisQueries += thisTotals.totalQueries;
    teamLastQueries += lastTotals.totalQueries;
    teamThisSessions += thisTotals.totalSessions;
    teamLastSessions += lastTotals.totalSessions;
    teamThisCost += thisTotals.totalCost;
    teamLastCost += lastTotals.totalCost;
    if (thisTotals.totalQueries > lastTotals.totalQueries) devsMoreActive++;
  }

  return {
    weekStart: thisFrom,
    weekEnd: thisTo,
    prevWeekStart: lastFrom,
    prevWeekEnd: lastTo,
    devDeltas,
    teamSummary: {
      queriesPct: calcPct(teamThisQueries, teamLastQueries),
      devsMoreActive,
      totalDevs: allDevs.length,
    },
  };
}

/* === FEATURE 4a: Inactive Dev Flag === */
function getInactivityStatus() {
  const allDevs = loadAllDevelopers();
  const now = Date.now();
  const result = {};

  // Use calendar-day difference so "yesterday at 10pm" counts as 1 day ago, not 0
  const todayStr = new Date(now).toISOString().split('T')[0];
  function calendarDaysDiff(dateStr) {
    const a = new Date(todayStr);
    const b = new Date(dateStr);
    return Math.round((a - b) / 86400000);
  }

  for (const dev of allDevs) {
    const syncDateStr = dev.lastSync ? dev.lastSync.split('T')[0] : null;
    const daysSinceLastSync = syncDateStr ? calendarDaysDiff(syncDateStr) : 999;

    // Find last session date
    let lastSessionDate = null;
    for (const s of (dev.sessions || [])) {
      if (s.date && s.date !== 'unknown') {
        if (!lastSessionDate || s.date > lastSessionDate) lastSessionDate = s.date;
      }
    }
    const daysSinceLastSession = lastSessionDate
      ? calendarDaysDiff(lastSessionDate)
      : 999;

    let flag = 'ok';
    if (daysSinceLastSync >= 7) flag = 'critical';
    else if (daysSinceLastSync >= 4) flag = 'warning';

    result[dev.devId] = {
      daysSinceLastSync,
      daysSinceLastSession,
      flag,
    };
  }

  return result;
}

module.exports = { getProductivityAnalytics, getWeekOverWeekDeltas, getInactivityStatus };

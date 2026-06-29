#!/usr/bin/env node

// Boot script: loads config from SSM Parameter Store, then starts the team server.
// Falls back to env vars / .env if SSM is not configured.

const SSM_PREFIX = process.env.SSM_PREFIX || '/claude-spend/';
const SSM_MAX_ATTEMPTS = Number(process.env.SSM_MAX_ATTEMPTS || 5);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSSMParams() {
  const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');
  const client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  let nextToken;
  let loaded = 0;
  do {
    const res = await client.send(new GetParametersByPathCommand({
      Path: SSM_PREFIX,
      WithDecryption: true,
      NextToken: nextToken,
    }));
    for (const p of (res.Parameters || [])) {
      const key = p.Name.slice(SSM_PREFIX.length);
      if (!process.env[key]) {
        process.env[key] = p.Value;
        console.log(`[SSM] Loaded ${key}`);
        loaded++;
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return loaded;
}

// Load config from SSM, retrying with exponential backoff. The observed production
// failure was a transient DNS error (getaddrinfo EAI_AGAIN) at boot, which left the
// server running with no S3 config and an empty dashboard. Retrying makes a transient
// blip recoverable instead of fatal-but-silent.
async function loadSSMParams() {
  if (!SSM_PREFIX) return;
  for (let attempt = 1; attempt <= SSM_MAX_ATTEMPTS; attempt++) {
    try {
      await fetchSSMParams();
      return;
    } catch (err) {
      const last = attempt === SSM_MAX_ATTEMPTS;
      console.warn(`[SSM] Load attempt ${attempt}/${SSM_MAX_ATTEMPTS} failed: ${err.message}`);
      if (last) {
        console.warn('[SSM] Giving up; starting with env/.env config only.');
        return;
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
      await sleep(delayMs);
    }
  }
}

(async () => {
  await loadSSMParams();
  require('./team-server');
})();

#!/usr/bin/env node

// Boot script: loads config from SSM Parameter Store, then starts the team server.
// Falls back to env vars / .env if SSM is not configured.

const SSM_PREFIX = process.env.SSM_PREFIX || '/claude-spend/';

async function loadSSMParams() {
  if (!SSM_PREFIX) return;
  try {
    const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');
    const client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    let nextToken;
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
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch (err) {
    console.warn('[SSM] Could not load params:', err.message);
  }
}

(async () => {
  await loadSSMParams();
  require('./team-server');
})();

'use strict';

function handoffPlan(startedMs, durationSeconds, overlapSeconds = 1200, warmupSeconds = 1200) {
  for (const value of [startedMs, durationSeconds, overlapSeconds, warmupSeconds]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid handoff timing');
  }
  if (!durationSeconds || overlapSeconds + warmupSeconds >= durationSeconds) throw new Error('Session is too short for this handoff');
  const endEpoch = Math.floor(startedMs / 1000) + durationSeconds;
  return { endEpoch, startEpoch: endEpoch - overlapSeconds, dispatchEpoch: endEpoch - overlapSeconds - warmupSeconds };
}

function bridgePlan(startedMs, durationSeconds) {
  return handoffPlan(startedMs, durationSeconds, 120, 600);
}

function bridgeRunTitle(sourceRun) {
  targetRunTitle(sourceRun);
  return `bot1 · transition bridge from ${sourceRun}`;
}

function targetRunTitle(sourceRun) {
  if (!/^\d+$/.test(String(sourceRun))) throw new Error('Invalid source run ID');
  return `luvhi · handoff from ${sourceRun}`;
}

function sourceRunning(run, jobs, sourceJob = 'Sothey 2/2') {
  if (run.status === 'completed') return false;
  const steps = {
    'Sothey 1/2': 'Stay connected and arrange bridge',
    'Sothey 2/2': 'Stay connected and arrange handoff',
    'luvhi 1/2': 'Connect luvhi',
    'luvhi 1/3': 'Connect luvhi',
    'luvhi 2/3': 'Connect luvhi'
  };
  if (!steps[sourceJob]) return false;
  return jobs.some(job => job.name === sourceJob && job.status === 'in_progress'
    && (job.steps || []).some(step => step.name === steps[sourceJob] && step.status === 'in_progress'));
}

function validateGate(startEpoch, sourceRun, nowSeconds, overlapSeconds = 1200) {
  if (!Number.isSafeInteger(startEpoch) || startEpoch <= 0) throw new Error('Invalid start_epoch');
  targetRunTitle(sourceRun);
  if (startEpoch - nowSeconds > 3600) throw new Error('Warm-up exceeds the bounded one-hour limit');
  if (nowSeconds >= startEpoch + overlapSeconds) throw new Error('Handoff window has already ended');
}

async function githubApi(method, endpoint, body) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) throw new Error('Missing GitHub workflow context');
  if (!endpoint.startsWith('/actions/') && !/^\/statuses\/[0-9a-f]{40}$/i.test(endpoint)) throw new Error('Only this repository Actions/status API is allowed');
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'Sothey-Handoff' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${endpoint.split('?')[0]} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}

module.exports = { handoffPlan, bridgePlan, bridgeRunTitle, targetRunTitle, sourceRunning, validateGate, githubApi };

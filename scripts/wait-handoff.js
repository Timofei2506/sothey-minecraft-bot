'use strict';
const { validateGate, sourceRunning, githubApi } = require('../src/handoff');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const startEpoch = Number(process.env.HANDOFF_START_EPOCH);
  const sourceRun = process.env.HANDOFF_SOURCE_RUN;
  const bridge = process.env.HANDOFF_KIND === 'bridge';
  const sourceJob = bridge ? process.env.HANDOFF_SOURCE_JOB : 'Sothey 2/2';
  const overlapSeconds = bridge ? 120 : 1200;
  validateGate(startEpoch, sourceRun, Math.floor(Date.now() / 1000), overlapSeconds);
  console.log(JSON.stringify({ event: 'HANDOFF_WARMUP', startAt: new Date(startEpoch * 1000).toISOString(), sourceRun }));
  while (true) {
    const [run, jobs] = await Promise.all([
      githubApi('GET', `/actions/runs/${sourceRun}`),
      githubApi('GET', `/actions/runs/${sourceRun}/jobs?per_page=100`)
    ]);
    if (!sourceRunning(run, jobs.jobs, sourceJob)) throw new Error('Source Sothey session stopped; cancelling the handoff rather than replacing a banned/failed/cancelled client');
    const remainingMs = startEpoch * 1000 - Date.now();
    if (remainingMs <= 0) {
      validateGate(startEpoch, sourceRun, Math.floor(Date.now() / 1000), overlapSeconds);
      console.log(JSON.stringify({ event: 'HANDOFF_TIME_REACHED', delaySeconds: Math.max(0, Math.round(-remainingMs / 1000)) }));
      return;
    }
    console.log(JSON.stringify({ event: 'HANDOFF_WAIT', remainingSeconds: Math.ceil(remainingMs / 1000) }));
    await sleep(Math.min(60000, remainingMs));
  }
}
main().catch(error => { console.error(error.message); process.exit(1); });

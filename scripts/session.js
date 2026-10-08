'use strict';
const fs = require('node:fs');
const { readConfig, redact } = require('../src/helpers');
const { runBot } = require('../src/main');
const { handoffPlan, targetRunTitle, githubApi } = require('../src/handoff');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const config = readConfig();
  const enabled = process.env.HANDOFF_ENABLED === 'true';
  let finished = false;
  let handoffDone = !enabled;
  let dispatchTask = null;
  let timer = null;
  if (enabled) {
    if (config.username !== 'Sothey') throw new Error('Only Sothey can initiate this one-off handoff');
    const plan = handoffPlan(Date.now(), config.runSeconds);
    const sourceRun = process.env.GITHUB_RUN_ID;
    const title = targetRunTitle(sourceRun);
    console.log(JSON.stringify({ event: 'HANDOFF_PLAN', username: 'luvhi', ...plan, sourceRun }));
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/handoff.json', JSON.stringify({ ...plan, sourceRun, title }, null, 2));

    async function dispatch() {
      for (let attempt = 1; attempt <= 5 && !finished; attempt++) {
        try {
          const status = JSON.parse(fs.readFileSync('reports/status.json', 'utf8'));
          if (!status.ready || !status.authenticated) {
            console.log(JSON.stringify({ event: 'HANDOFF_WAITING_FOR_SOURCE', attempt }));
            await sleep(15000);
            continue;
          }
          // Deduplicate even if a previous request timed out after being accepted.
          const previous = await githubApi('GET', '/actions/workflows/luvhi.yml/runs?event=workflow_dispatch&per_page=100');
          const existing = previous.workflow_runs.find(run => run.display_title === title);
          if (!existing) {
            await githubApi('POST', '/actions/workflows/luvhi.yml/dispatches', {
              ref: process.env.GITHUB_REF_NAME || 'main',
              inputs: { mode: 'handoff', start_epoch: String(plan.startEpoch), source_run: String(sourceRun), expect_new: 'false' }
            });
          }
          handoffDone = true;
          console.log(JSON.stringify({ event: 'HANDOFF_SCHEDULED', username: 'luvhi', startAt: new Date(plan.startEpoch * 1000).toISOString(), existingRun: existing?.id || null }));
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nLuvhi handoff scheduled for ${new Date(plan.startEpoch * 1000).toISOString()} (20 minutes before Sothey's deadline).\n`);
          return;
        } catch (error) {
          console.error(JSON.stringify({ event: 'HANDOFF_DISPATCH_RETRY', attempt, message: redact(error.message, [config.password, process.env.GH_TOKEN]) }));
          if (attempt < 5 && !finished) await sleep(15000);
        }
      }
      console.error('HANDOFF_NOT_SCHEDULED: the current Sothey session continues to its deadline.');
    }
    timer = setTimeout(() => { dispatchTask = dispatch(); }, Math.max(0, plan.dispatchEpoch * 1000 - Date.now()));
  }
  const code = await runBot(config);
  finished = true;
  clearTimeout(timer);
  if (dispatchTask) await dispatchTask;
  return code || (handoffDone ? 0 : 1);
}
main().then(code => process.exit(code)).catch(error => {
  console.error(redact(error.message, [process.env.MC_PASSWORD, process.env.GH_TOKEN]));
  process.exit(1);
});

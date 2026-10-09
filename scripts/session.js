'use strict';
const fs = require('node:fs');
const { readConfig, redact } = require('../src/helpers');
const { runBot } = require('../src/main');
const { handoffPlan, bridgePlan, targetRunTitle, bridgeRunTitle, githubApi } = require('../src/handoff');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WANDER_EVENTS = new Set([
  'WANDER_ANCHOR', 'WANDER_RADIUS', 'WANDER_DISABLED', 'WANDER_REANCHORED',
  'WANDER_LEG_START', 'WANDER_LEG_END', 'WANDER_STOPPED'
]);

function wanderEvent(name) {
  return WANDER_EVENTS.has(name);
}

function wanderDescription(event) {
  if (event.event === 'WANDER_RADIUS') return `wander radius ${event.radius} blocks (block under spawn: ${event.block}, gold ore: ${event.goldOre})`;
  if (event.event === 'WANDER_ANCHOR') return `wander anchor x=${event.x} y=${event.y} z=${event.z}`;
  if (event.event === 'WANDER_LEG_END') return `walked ${event.moved} blocks`;
  if (event.event === 'WANDER_STOPPED') return `walk stopped: ${event.reason} (radius ${event.radius})`;
  if (event.event === 'WANDER_REANCHORED') return `anchor moved by admin teleport (${event.jump} blocks)`;
  if (event.event === 'WANDER_DISABLED') return `walking disabled: ${event.reason}`;
  return event.event;
}

async function main() {
  const config = readConfig();
  const handoff = process.env.HANDOFF_ENABLED === 'true';
  const bridge = process.env.BRIDGE_ENABLED === 'true';
  if (handoff && bridge) throw new Error('A session cannot schedule both kinds of transition');
  const enabled = handoff || bridge;
  let finished = false;
  let scheduled = !enabled;
  let dispatchTask = null;
  let timer = null;
  if (enabled) {
    if (handoff && config.username !== 'Sothey') throw new Error('Only Sothey initiates the one-off luvhi handoff');
    const planStart = config.deadlineEpoch ? (config.deadlineEpoch - config.runSeconds) * 1000 : Date.now();
    const plan = bridge ? bridgePlan(planStart, config.runSeconds) : handoffPlan(planStart, config.runSeconds);
    const sourceRun = process.env.GITHUB_RUN_ID;
    const title = bridge ? bridgeRunTitle(sourceRun) : targetRunTitle(sourceRun);
    const target = bridge ? 'bot1' : 'luvhi';
    const workflow = bridge ? 'bridge.yml' : 'luvhi.yml';
    const kind = bridge ? 'BRIDGE' : 'HANDOFF';
    const inputs = bridge
      ? { start_epoch: String(plan.startEpoch), source_run: String(sourceRun), source_job: process.env.SOURCE_JOB_NAME }
      : { mode: 'handoff', start_epoch: String(plan.startEpoch), source_run: String(sourceRun), expect_new: 'false' };
    if (bridge && !['Sothey 1/2', 'luvhi 1/2', 'luvhi 1/3', 'luvhi 2/3'].includes(inputs.source_job)) throw new Error('Invalid bridge source job');
    console.log(JSON.stringify({ event: `${kind}_PLAN`, username: target, ...plan, sourceRun }));
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(`reports/${kind.toLowerCase()}.json`, JSON.stringify({ ...plan, sourceRun, title }, null, 2));

    async function dispatch() {
      let failures = 0;
      while (!finished && failures < 5 && Date.now() < plan.startEpoch * 1000) {
        try {
          const status = JSON.parse(fs.readFileSync('reports/status.json', 'utf8'));
          if (!status.ready || !status.authenticated) {
            console.log(JSON.stringify({ event: `${kind}_WAITING_FOR_SOURCE` }));
            await sleep(15000);
            continue;
          }
          // A timed-out POST may have been accepted. Check by unique source-run title.
          const previous = await githubApi('GET', `/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`);
          const existing = previous.workflow_runs.find(run => run.display_title === title);
          if (!existing) {
            await githubApi('POST', `/actions/workflows/${workflow}/dispatches`, {
              ref: process.env.GITHUB_REF_NAME || 'main', inputs
            });
          }
          scheduled = true;
          console.log(JSON.stringify({ event: `${kind}_SCHEDULED`, username: target, startAt: new Date(plan.startEpoch * 1000).toISOString(), existingRun: existing?.id || null }));
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${target} scheduled for ${new Date(plan.startEpoch * 1000).toISOString()}.\n`);
          return;
        } catch (error) {
          failures++;
          console.error(JSON.stringify({ event: `${kind}_DISPATCH_RETRY`, attempt: failures, message: redact(error.message, [config.password, process.env.GH_TOKEN]) }));
          if (failures < 5 && !finished) await sleep(15000);
        }
      }
      console.error(`${kind}_NOT_SCHEDULED: the current client continues to its deadline.`);
    }
    timer = setTimeout(() => { dispatchTask = dispatch(); }, Math.max(0, plan.dispatchEpoch * 1000 - Date.now()));
  }
  let statusQueue = Promise.resolve();
  const beacon = process.env.BOT_GITHUB_STATUS === 'true';
  const code = await runBot(config, {
    onEvent: event => {
      if (!beacon) return;
      if (wanderEvent(event.event)) {
        const wanderContext = `minecraft/${config.username}-wander`;
        const state = /DISABLED|STOPPED|UNSAFE/.test(event.event) ? 'failure' : /LEG_END|REANCHORED|RADIUS/.test(event.event) ? 'success' : 'pending';
        statusQueue = statusQueue.then(() => githubApi('POST', `/statuses/${process.env.GITHUB_SHA}`, {
          state, context: wanderContext, description: wanderDescription(event).slice(0, 140),
          target_url: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        })).catch(error => console.error(JSON.stringify({ event: 'STATUS_BEACON_ERROR', message: error.message })));
        return;
      }
      if (!['START', 'READY', 'DISCONNECTED', 'CONNECTION_RETRY', 'STOP'].includes(event.event)) return;
      const state = event.event === 'READY' ? 'success' : event.event === 'STOP' ? (event.exitCode === 0 ? 'success' : 'failure') : 'pending';
      const description = event.event === 'READY' ? `${config.username}: authenticated and ready` : event.event === 'STOP' ? `${config.username}: session finished (${event.reason})` : `${config.username}: connecting / not verified`;
      statusQueue = statusQueue.then(() => githubApi('POST', `/statuses/${process.env.GITHUB_SHA}`, {
        state, context: `minecraft/${config.username}`, description: description.slice(0, 140),
        target_url: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      })).catch(error => console.error(JSON.stringify({ event: 'STATUS_BEACON_ERROR', message: error.message })));
    }
  });
  await statusQueue;
  finished = true;
  clearTimeout(timer);
  if (dispatchTask) await dispatchTask;
  return code || (scheduled ? 0 : 1);
}
main().then(code => process.exit(code)).catch(error => {
  console.error(redact(error.message, [process.env.MC_PASSWORD, process.env.GH_TOKEN]));
  process.exit(1);
});

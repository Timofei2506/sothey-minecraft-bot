'use strict';
const fs = require('node:fs');
let report = null;
if (fs.existsSync('reports/status.json')) {
  report = JSON.parse(fs.readFileSync('reports/status.json', 'utf8'));
  console.log(JSON.stringify(report, null, 2));
}
// A finite period ending while offline may continue in the next bounded job.
// Password errors, bans, manual cancellation and programming errors may not.
const canContinue = report?.finalReason === 'duration_reached';
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `can_continue=${canContinue}\n`);
if (!report) console.log('No session report; next session is not authorized.');

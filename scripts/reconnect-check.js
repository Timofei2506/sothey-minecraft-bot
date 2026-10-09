'use strict';
const mineflayer = require('mineflayer');
const fs = require('node:fs');
const { runBot } = require('../src/main');
const { readConfig, authAction, authSucceeded, redact } = require('../src/helpers');

function suppressAuthUntilProbe(client, gate, log = console.log) {
  // createBot returns before chat plugins are initialized. This decorator only
  // needs EventEmitter and also handles connections rejected before login.
  const emit = client.emit.bind(client);
  client.emit = (event, ...args) => {
    if (event === 'messagestr' && !gate.probed && (authAction(args[0]) || authSucceeded(args[0]))) {
      log('TEST_SUPPRESSED_INITIAL_AUTH_NOTICE');
      return false;
    }
    return emit(event, ...args);
  };
}

async function main() {
  const config = readConfig();
  let attempts = 0;
  let current;
  let currentGate = null;
  let triggered = false;
  let forced = false;
  let timer;
  const code = await runBot(config, {
    createBot: options => {
      current = mineflayer.createBot(options);
      attempts++;
      if (attempts > 1) {
        // A reconnect attempt can be rate-limited before joining. Keep testing
        // missing notices on every later attempt, not only TCP attempt number 2.
        currentGate = { probed: false };
        suppressAuthUntilProbe(current, currentGate);
      }
      return current;
    },
    onEvent: event => {
      if (currentGate && event.event === 'AUTH_COMMAND' && event.command === '/login') currentGate.probed = true;
      if (event.event === 'READY' && !triggered) {
        triggered = true;
        timer = setTimeout(() => {
          const others = Object.keys(current.players || {}).filter(name => name !== config.username);
          if (!others.length) { console.log('TEST_ABORTED_NO_OTHER_PLAYER_TO_HOLD_SERVER'); return; }
          forced = true;
          console.log('TEST_FORCING_ONE_NETWORK_DISCONNECT');
          current._client.socket.destroy();
        }, 30000);
      }
    }
  });
  clearTimeout(timer);
  const report = JSON.parse(fs.readFileSync('reports/status.json', 'utf8'));
  const passed = forced && code === 0 && report.readySessions >= 2 && report.authProbes >= 1;
  console.log(passed ? 'RECONNECT_WITH_MISSING_NOTICE_PASS' : 'RECONNECT_WITH_MISSING_NOTICE_FAIL');
  return passed ? 0 : 1;
}

if (require.main === module) main().then(code => process.exit(code)).catch(error => {
  console.error(redact(error.message, [process.env.MC_PASSWORD]));
  process.exit(1);
});
module.exports = { suppressAuthUntilProbe };

'use strict';
const mineflayer = require('mineflayer');
const fs = require('node:fs');
const { runBot } = require('../src/main');
const { readConfig, authAction, authSucceeded, redact } = require('../src/helpers');

async function main() {
  const config = readConfig();
  let connections = 0;
  let permitSecondAuthNotice = false;
  let current;
  let triggered = false;
  let forced = false;
  let timer;
  const code = await runBot(config, {
    createBot: options => {
      current = mineflayer.createBot(options);
      const client = current;
      connections++;
      if (connections === 2) {
        // Test the exact missing-auth-notice scenario without changing the server.
        const originalEmit = client.emit.bind(client);
        client.emit = (event, ...args) => {
          if (event === 'messagestr' && !permitSecondAuthNotice && (authAction(args[0]) || authSucceeded(args[0]))) {
            console.log('TEST_SUPPRESSED_INITIAL_AUTH_NOTICE');
            return false;
          }
          return originalEmit(event, ...args);
        };
      }
      return client;
    },
    onEvent: event => {
      // Mineflayer injects chat asynchronously. Observe the core's auth event
      // instead of binding a chat method before plugins have initialized.
      if (connections === 2 && event.event === 'AUTH_COMMAND' && event.command === '/login') permitSecondAuthNotice = true;
      if (event.event === 'READY' && !triggered) {
        triggered = true;
        timer = setTimeout(() => {
          // Never deliberately disconnect the last visible player during this test.
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
main().then(code => process.exit(code)).catch(error => {
  console.error(redact(error.message, [process.env.MC_PASSWORD]));
  process.exit(1);
});

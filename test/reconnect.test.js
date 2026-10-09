'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBot } = require('../src/main');
const { readConfig, authSucceeded } = require('../src/helpers');

function setup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1790000000000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sothey-regression-'));
  const abort = new AbortController();
  const events = [];
  const bots = [];
  const config = readConfig({ MC_PASSWORD: 'not-a-real-password', BOT_RUN_SECONDS: '600', BOT_MIN_READY_SECONDS: '1', BOT_IDLE_ACTIVITY_SECONDS: '0', BOT_JOIN_TIMEOUT_SECONDS: '30', BOT_MAX_OFFLINE_SECONDS: '60', ...overrides });
  const promise = runBot(config, {
    reportDir: directory, silent: true, signal: abort.signal, random: () => 0,
    onEvent: event => events.push(event),
    createBot: () => {
      const bot = new EventEmitter();
      Object.assign(bot, { username: 'Sothey', health: 20, game: { dimension: 'overworld' }, entity: { onGround: true }, commands: [], quickBarSlot: 0 });
      bot.chat = text => bot.commands.push(text);
      bot.swingArm = () => {};
      bot.setQuickBarSlot = value => { bot.quickBarSlot = value; };
      bot.quit = reason => { if (!bot.closed) { bot.closed = true; bot.emit('end', reason); } };
      bot._client = { socket: { destroy: () => bot.quit('socketClosed') } };
      bots.push(bot);
      return bot;
    }
  });
  const advance = ms => t.mock.timers.tick(ms);
  t.after(async () => { abort.abort(); advance(2000); await promise; fs.rmSync(directory, { recursive: true, force: true }); });
  return { bots, events, advance, promise, directory, spawn(bot = bots.at(-1), dimension = 'overworld') { bot.game.dimension = dimension; bot.emit('login'); bot.emit('spawn'); } };
}

test('already-logged-in acknowledgements are recognized, ordinary chat is not', () => {
  for (const m of ['You are already logged in!', "You're already logged in!", 'Already logged in!', 'Вы уже авторизованы!', 'Вы уже вошли в систему!']) assert.equal(authSucceeded(m), true, m);
  for (const m of ['Welcome to the_end', 'Unknown command', '<Steve> Already logged in!', '[Игрок]Steve » You are already logged in!']) assert.equal(authSucceeded(m), false, m);
});

test('missing auth notice causes a rate-limited login probe, not assumed readiness', t => {
  const x = setup(t); x.spawn(); x.advance(12000);
  assert.equal(x.bots[0].commands.length, 1);
  assert.ok(x.bots[0].commands[0].startsWith('/login '));
  assert.equal(x.events.some(e => e.event === 'READY'), false);
  x.bots[0].emit('messagestr', 'You are already logged in!'); x.advance(10000);
  assert.equal(x.events.filter(e => e.event === 'READY').length, 1);
});

test('the reported Server closed → missing-auth reconnect sequence recovers', t => {
  const x = setup(t); x.spawn();
  x.bots[0].emit('messagestr', 'Successful login!'); x.advance(10000);
  x.bots[0].emit('kicked', 'Server closed'); x.bots[0].quit('socketClosed');
  x.advance(15000); assert.equal(x.bots.length, 2); x.spawn(x.bots[1], 'the_end');
  x.advance(12000);
  assert.equal(x.bots[1].commands.length, 1);
  assert.equal(x.events.filter(e => e.event === 'READY').length, 1);
  x.bots[1].emit('messagestr', "You're already logged in!"); x.advance(10000);
  assert.equal(x.events.filter(e => e.event === 'READY').length, 2);
  assert.equal(x.events.some(e => e.event === 'STOP'), false);
});

test('a limbo spawn with no authentication recycles connections instead of ending the job', t => {
  const x = setup(t); x.spawn(x.bots[0], 'the_end');
  x.advance(30000);
  assert.ok(x.events.some(e => e.event === 'CONNECTION_RETRY' && e.terminal === false));
  assert.equal(x.events.some(e => e.event === 'STOP'), false);
  x.advance(15000); assert.equal(x.bots.length, 2);
  x.advance(160000);
  assert.equal(x.events.some(e => e.event === 'STOP'), false);
  assert.equal(x.events.some(e => e.event === 'READY'), false);
  assert.ok(x.events.some(e => e.event === 'OUTAGE_WARNING'));
});

test('old connection messages cannot authenticate a new connection', t => {
  const x = setup(t); x.spawn(); const old = x.bots[0];
  old.quit('network failure'); x.advance(15000); x.spawn();
  old.emit('messagestr', 'Successful login!'); x.advance(10000);
  assert.equal(x.events.some(e => e.event === 'READY'), false);
});

test('wrong password remains terminal and is never retried as a network issue', async t => {
  const x = setup(t); x.spawn(); x.bots[0].emit('messagestr', 'Wrong password!'); x.advance(2000);
  assert.equal(await x.promise, 1);
  assert.equal(x.events.at(-1).reason, 'server_authentication_rejected');
  assert.equal(x.events.some(e => e.event === 'RECONNECT_SCHEDULED'), false);
});

test('new-account check never probes a possibly pre-existing account password', t => {
  const x = setup(t, { BOT_EXPECT_NEW_ACCOUNT: 'true' }); x.spawn(); x.advance(12000);
  assert.equal(x.bots[0].commands.length, 0);
});

test('being healthy earlier does not produce PASS when the deadline ends offline', async t => {
  const x = setup(t, { BOT_RUN_SECONDS: '60' }); x.spawn();
  x.bots[0].emit('messagestr', 'Successful login!'); x.advance(10000); x.advance(5000);
  x.bots[0].quit('socketClosed'); x.advance(47000); x.advance(2000);
  assert.equal(await x.promise, 1);
  const report = JSON.parse(fs.readFileSync(path.join(x.directory, 'status.json')));
  assert.equal(report.finalReason, 'duration_reached');
  assert.equal(report.readyAtEnd, false);
  assert.ok(report.readySeconds > 0);
});

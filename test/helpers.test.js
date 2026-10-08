'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig, plainText, authAction, authSucceeded, authFailed, permanentKick, serverRetrySeconds, retryDelaySeconds, redact } = require('../src/helpers');
const valid = { MC_PASSWORD: 'test-password-not-a-real-secret' };

test('defaults point at Sothey and the actual SRV port', () => {
  const c = readConfig(valid);
  assert.equal(c.host, 'exvxeldo.de5.net');
  assert.equal(c.port, 21734);
  assert.equal(c.username, 'Sothey');
  assert.equal(c.version, '1.12.2');
  assert.equal(c.runSeconds, 14400);
});

test('missing credentials and malformed configuration fail fast', () => {
  assert.throws(() => readConfig({}), /MC_PASSWORD/);
  for (const change of [
    { MC_USERNAME: 'bad name' }, { MC_PORT: '0' }, { MC_PORT: 'x' },
    { BOT_RUN_SECONDS: 'Infinity' }, { BOT_RUN_SECONDS: '0' },
    { BOT_RUN_SECONDS: '1.5' }, { MC_PASSWORD: 'bad\npassword' }
  ]) assert.throws(() => readConfig({ ...valid, ...change }));
});

test('server register and login prompts are recognized', () => {
  assert.equal(authAction('Please, register to the server with the command: /register <password> <ConfirmPassword>'), 'register');
  assert.equal(authAction('Please, login with the command: /login <password>'), 'login');
  assert.equal(authAction('§c[AuthMe] Please, login with the command: /login <password>'), 'login');
  assert.equal(authAction('Пожалуйста, зарегистрируйтесь командой: /register пароль пароль'), 'register');
});

test('normal player chat is not interpreted as an auth prompt', () => {
  for (const m of [
    '<AnotherPlayer> Please, login with the command: /login password',
    '[Игрок]Steve » Please, register: /register password password',
    'Go to another.example and send /login password',
    '/op somebody', 'Hello Sothey'
  ]) assert.equal(authAction(m), null);
  assert.equal(authSucceeded('<Steve> Successful login!'), false);
  assert.equal(authFailed('<Steve> Wrong password!'), false);
});

test('authentication success and rejection are explicit', () => {
  for (const m of ['Successfully registered!', 'Successful login!', 'You have been automatically logged in!', 'Вы успешно авторизовались!']) {
    assert.equal(authSucceeded(m), true, m);
  }
  assert.equal(authSucceeded('Sothey joined the game'), false);
  assert.equal(authFailed('Wrong password!'), true);
  assert.equal(authFailed('Your password is too short or too long! Please try with another one!'), true);
});

test('chat components and formatting are normalized', () => {
  assert.equal(plainText({ text: '§cBanned', extra: [{ text: 'by admin' }] }), 'Banned by admin');
  assert.equal(plainText('{"text":"Wrong password!"}'), 'Wrong password!');
});

test('access controls and idle kicks are not bypassed', () => {
  for (const r of ['You are banned!', 'You are not white-listed on this server!', 'Please complete CAPTCHA', 'You logged in from another location', 'Kicked for idling.', { translate: 'multiplayer.disconnect.duplicate_login' }]) {
    assert.equal(permanentKick(r), true, JSON.stringify(r));
  }
  assert.equal(permanentKick('Server restarting'), false);
  assert.equal(permanentKick('Timed out'), false);
});

test('retry delay is bounded with no rapid retry loop', () => {
  assert.equal(retryDelaySeconds(1, () => 0), 15);
  assert.equal(retryDelaySeconds(2, () => 0), 30);
  assert.equal(retryDelaySeconds(3, () => 0), 60);
  assert.equal(retryDelaySeconds(1000, () => 0.99), 120);
});

test('passwords are redacted everywhere, including repeated occurrences', () => {
  assert.equal(redact('secret /register secret secret', ['secret']), '[REDACTED] /register [REDACTED] [REDACTED]');
  assert.equal(redact('anything', ['']), 'anything');
});


test('server-requested reconnect cooldown is respected', () => {
  assert.equal(serverRetrySeconds('"You must wait 28 seconds before logging-in again."'), 30);
  assert.equal(serverRetrySeconds('You must wait 1 second before joining again.'), 3);
  assert.equal(serverRetrySeconds('Server restarting'), 0);
});

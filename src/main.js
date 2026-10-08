'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mineflayer = require('mineflayer');
const { readConfig, plainText, authAction, authSucceeded, authFailed, permanentKick, serverRetrySeconds, retryDelaySeconds, redact } = require('./helpers');

function runBot(config) {
  return new Promise((resolve) => {
    const started = Date.now();
    const deadline = started + config.runSeconds * 1000;
    const stats = { attempts: 0, connections: 0, authenticatedConnections: 0, readySessions: 0, disconnects: 0, activityCount: 0 };
    let bot = null;
    let stopping = false;
    let ready = false;
    let authenticated = false;
    let registeredHere = false;
    let spawned = false;
    let readySince = null;
    let readyMs = 0;
    let lastReadyAt = started;
    let connectionStarted = started;
    let failures = 0;
    let retryTimer = null;
    let settleTimer = null;
    let authSent = new Set();
    let serverWaitSeconds = 0;
    let finalReason = null;
    let finalCode = null;
    const timers = new Set();
    const reportDir = path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportDir, { recursive: true });

    function log(event, data = {}) {
      console.log(redact(JSON.stringify({ time: new Date().toISOString(), event, ...data }), [config.password]));
    }

    function connectedSeconds() {
      return Math.floor((readyMs + (readySince === null ? 0 : Date.now() - readySince)) / 1000);
    }

    function snapshot() {
      return {
        updatedAt: new Date().toISOString(),
        startedAt: new Date(started).toISOString(),
        plannedEndAt: new Date(deadline).toISOString(),
        host: config.host, port: config.port, username: config.username, version: config.version,
        status: stopping ? 'stopped' : ready ? 'ready' : bot ? 'joining' : 'reconnecting',
        authenticated, ready, readySeconds: connectedSeconds(),
        elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        ...stats, finalReason, exitCode: finalCode
      };
    }

    function writeReport() {
      const data = redact(JSON.stringify(snapshot(), null, 2), [config.password]);
      fs.writeFileSync(path.join(reportDir, 'status.tmp'), data + '\n');
      fs.renameSync(path.join(reportDir, 'status.tmp'), path.join(reportDir, 'status.json'));
    }

    function endReadyPeriod() {
      if (readySince !== null) {
        readyMs += Date.now() - readySince;
        lastReadyAt = Date.now();
        readySince = null;
      }
      ready = false;
    }

    function finish(reason, code) {
      if (stopping) return;
      stopping = true;
      endReadyPeriod();
      finalReason = reason;
      finalCode = code === undefined ? (connectedSeconds() >= config.minReadySeconds ? 0 : 1) : code;
      for (const timer of timers) clearInterval(timer);
      clearTimeout(retryTimer);
      clearTimeout(settleTimer);
      writeReport();
      log('STOP', { reason, exitCode: finalCode, readySeconds: connectedSeconds(), ...stats });
      if (process.env.GITHUB_STEP_SUMMARY) {
        const summary = [
          `## ${config.username} session report`,
          `- Result: **${finalCode === 0 ? 'PASS' : 'FAIL'}**`,
          `- Authenticated in-world time: **${connectedSeconds()} seconds**`,
          `- Successful ready sessions: ${stats.readySessions}`,
          `- Reconnects/disconnects: ${stats.disconnects}`,
          `- Stop reason: \`${reason}\``,
          `- Idle activity packets: ${stats.activityCount} (arm animation and held-slot selection; no attacks or chat).`, ''
        ].join('\n');
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      try { bot?.quit(`${config.username} session finished`); } catch { /* socket already closed */ }
      setTimeout(() => {
        try { bot?._client?.socket?.destroy(); } catch { /* already closed */ }
        process.off('SIGTERM', onTerm);
        process.off('SIGINT', onInt);
        resolve(finalCode);
      }, 1500);
    }

    function scheduleReady() {
      clearTimeout(settleTimer);
      if (!spawned || !authenticated || ready || stopping) return;
      // Authentication alone is not enough: wait for the world/teleport to settle.
      const current = bot;
      settleTimer = setTimeout(() => {
        if (stopping || bot !== current || !spawned || !authenticated || ready) return;
        ready = true;
        readySince = Date.now();
        lastReadyAt = Date.now();
        failures = 0;
        stats.readySessions++;
        log('READY', { username: config.username, version: config.version, authenticated: true });
        writeReport();
      }, 10000);
    }

    function scheduleReconnect() {
      if (stopping || Date.now() >= deadline) return;
      const seconds = Math.max(retryDelaySeconds(++failures), serverWaitSeconds);
      serverWaitSeconds = 0;
      log('RECONNECT_SCHEDULED', { seconds });
      retryTimer = setTimeout(connect, seconds * 1000);
    }

    function connect() {
      if (stopping || Date.now() >= deadline) return;
      stats.attempts++;
      connectionStarted = Date.now();
      authenticated = false;
      spawned = false;
      authSent = new Set();
      log('CONNECT', { host: config.host, port: config.port, username: config.username, version: config.version, attempt: stats.attempts });
      let current;
      try {
        current = mineflayer.createBot({
          host: config.host, port: config.port, username: config.username,
          version: config.version, auth: 'offline',
          viewDistance: 'tiny', respawn: true,
          hideErrors: true, logErrors: false,
          checkTimeoutInterval: 60000
        });
        bot = current;
      } catch (error) {
        log('CLIENT_CREATION_ERROR', { message: error.message });
        finish('client_creation_failed', 1);
        return;
      }

      current.on('login', () => {
        if (bot !== current || stopping) return;
        stats.connections++;
        log('LOGIN_PACKET', { username: current.username });
        writeReport();
      });

      current.on('spawn', () => {
        if (bot !== current || stopping) return;
        spawned = true;
        log('SPAWN', { dimension: current.game?.dimension });
        scheduleReady();
      });

      current.on('messagestr', (message) => {
        if (bot !== current || stopping) return;
        // Do not publish other players' chat to a public Actions log.
        const action = authAction(message);
        if (action) {
          if (action === 'login' && config.expectNewAccount && !registeredHere && !authSent.has('register')) {
            finish('username_already_registered_password_required', 1);
            return;
          }
          if (authenticated) endReadyPeriod();
          authenticated = false;
          clearTimeout(settleTimer);
          if (authSent.has(action)) return;
          authSent.add(action);
          log('AUTH_COMMAND', { command: `/${action}`, password: '[REDACTED]' });
          const command = action === 'register'
            ? `/register ${config.password} ${config.password}`
            : `/login ${config.password}`;
          current.chat(command);
        } else if (authSucceeded(message)) {
          if (authSent.has('register')) registeredHere = true;
          if (!authenticated) stats.authenticatedConnections++;
          authenticated = true;
          log('AUTHENTICATED');
          scheduleReady();
        } else if (authFailed(message)) {
          log('AUTH_FAILED', { notice: plainText(message).slice(0, 300) });
          finish('server_authentication_rejected', 1);
        }
      });

      current.on('death', () => {
        if (!stopping && bot === current) log('DEATH', { automaticRespawn: true });
      });

      current.on('kicked', (reason) => {
        if (bot !== current || stopping) return;
        log('KICKED', { reason: plainText(reason).slice(0, 500) });
        serverWaitSeconds = Math.max(serverWaitSeconds, serverRetrySeconds(reason));
        // Do not evade bans, whitelists, captcha, another user's session, or idle policy.
        if (permanentKick(reason)) finish('server_access_policy_or_authentication', 1);
      });

      current.on('error', (error) => {
        if (bot !== current || stopping) return;
        log('CONNECTION_ERROR', { code: error.code, message: error.message });
        if (/online.mode|microsoft|failed to verify username|invalid session/i.test(error.message)) {
          finish('premium_account_required', 1);
        }
      });

      current.on('end', (reason) => {
        if (bot !== current) return;
        endReadyPeriod();
        clearTimeout(settleTimer);
        authenticated = false;
        spawned = false;
        bot = null;
        if (stopping) return;
        stats.disconnects++;
        log('DISCONNECTED', { reason: plainText(reason).slice(0, 300) });
        writeReport();
        scheduleReconnect();
      });
    }

    function onTerm() { finish('SIGTERM', 143); }
    function onInt() { finish('SIGINT', 130); }
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    timers.add(setTimeout(() => finish('duration_reached'), config.runSeconds * 1000));
    timers.add(setInterval(() => {
      if (stopping) return;
      log('HEARTBEAT', { ready, authenticated, readySeconds: connectedSeconds(), remainingSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), health: bot?.health });
      writeReport();
    }, 30000));
    timers.add(setInterval(() => {
      if (stopping || ready) return;
      if (bot && Date.now() - connectionStarted > config.joinTimeoutSeconds * 1000) {
        finish('authentication_or_world_join_timeout', 1);
      } else if (Date.now() - lastReadyAt > config.maxOfflineSeconds * 1000) {
        finish('server_unreachable_too_long', 1);
      }
    }, 5000));
    if (config.idleActivitySeconds > 0) {
      timers.add(setInterval(() => {
        if (stopping || !ready || !authenticated || !bot || bot.health <= 0) return;
        try {
          bot.swingArm('right');
          bot.setQuickBarSlot(bot.quickBarSlot === 8 ? 7 : 8);
          stats.activityCount++;
          log('IDLE_ACTIVITY', { action: 'arm_animation_and_slot_change', count: stats.activityCount });
        } catch (error) {
          log('IDLE_ACTIVITY_ERROR', { message: error.message });
        }
      }, config.idleActivitySeconds * 1000));
    }
    log('START', { seconds: config.runSeconds, idleActivitySeconds: config.idleActivitySeconds, minReadySeconds: config.minReadySeconds, auth: 'offline + server password' });
    writeReport();
    connect();
  });
}

if (require.main === module) {
  let config;
  try { config = readConfig(); }
  catch (error) { console.error(error.message); process.exit(1); }
  runBot(config).then(code => process.exit(code)).catch(error => {
    console.error(redact(error.message, [config.password]));
    process.exit(1);
  });
}

module.exports = { runBot };

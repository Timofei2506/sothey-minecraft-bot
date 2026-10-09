'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mineflayer = require('mineflayer');
const { createWanderer } = require('./wander');
const { readConfig, plainText, authAction, authSucceeded, authFailed, authDiagnostic, permanentKick, serverRetrySeconds, retryDelaySeconds, redact } = require('./helpers');

// Dependencies are injectable so actual connection-state transitions can be tested
// with a simulated server/clock, not just string-matching unit tests.
function runBot(config, deps = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const deadline = config.deadlineEpoch ? config.deadlineEpoch * 1000 : started + config.runSeconds * 1000;
    const stats = { attempts: 0, connections: 0, authenticatedConnections: 0, readySessions: 0, disconnects: 0, activityCount: 0, authProbes: 0, recoverableTimeouts: 0 };
    let bot = null;
    let stopping = false;
    let recycling = false;
    let ready = false;
    let authenticated = false;
    let registeredHere = false;
    let spawned = false;
    let readyAtEnd = false;
    let readySince = null;
    let readyMs = 0;
    let lastReadyAt = started;
    let lastOutageWarning = started;
    let connectionStarted = started;
    let failures = 0;
    let retryTimer = null;
    let settleTimer = null;
    let authTimer = null;
    let forceCloseTimer = null;
    let authSent = new Set();
    let loginAttempts = 0;
    let lastLoginAttempt = -Infinity;
    let serverWaitSeconds = 0;
    let finalReason = null;
    let finalCode = null;
    const timers = new Set();
    const wanderer = config.wanderRadiusBlocks > 0
      ? createWanderer({
        getBot: () => bot, anchor: config.wanderAnchor, log,
        pauseMs: config.wanderPauseSeconds * 1000,
        jumpEveryLegs: config.wanderJumpEveryLegs
      })
      : null;
    const reportDir = deps.reportDir || path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportDir, { recursive: true });

    function log(event, data = {}) {
      const safe = redact(JSON.stringify({ time: new Date().toISOString(), event, ...data }), [config.password]);
      if (!deps.silent) console.log(safe);
      deps.onEvent?.(JSON.parse(safe));
    }

    function connectedSeconds() {
      return Math.floor((readyMs + (readySince === null ? 0 : Date.now() - readySince)) / 1000);
    }

    function snapshot() {
      return {
        updatedAt: new Date().toISOString(), startedAt: new Date(started).toISOString(), plannedEndAt: new Date(deadline).toISOString(),
        host: config.host, port: config.port, username: config.username, version: config.version,
        status: stopping ? 'stopped' : ready ? 'ready' : recycling || !bot ? 'reconnecting' : spawned ? 'unverified_world' : 'joining',
        wanderRadiusBlocks: config.wanderRadiusBlocks,
        wanderAnchor: wanderer?.getAnchor() || null,
        authenticated, ready, readyAtEnd, dimension: bot?.game?.dimension || null,
        readySeconds: connectedSeconds(), elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        ...stats, finalReason, exitCode: finalCode
      };
    }

    function writeReport() {
      const data = redact(JSON.stringify(snapshot(), null, 2), [config.password]);
      fs.writeFileSync(path.join(reportDir, 'status.tmp'), data + '\n');
      fs.renameSync(path.join(reportDir, 'status.tmp'), path.join(reportDir, 'status.json'));
    }

    function clearConnectionTimers() {
      clearTimeout(settleTimer);
      clearTimeout(authTimer);
      clearTimeout(forceCloseTimer);
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
      readyAtEnd = ready && authenticated;
      stopping = true;
      endReadyPeriod();
      finalReason = reason;
      // Being connected once earlier is not proof that the client is healthy now.
      finalCode = code === undefined ? (readyAtEnd && connectedSeconds() >= config.minReadySeconds ? 0 : 1) : code;
      for (const timer of timers) clearInterval(timer);
      clearTimeout(retryTimer);
      clearConnectionTimers();
      writeReport();
      log('STOP', { reason, exitCode: finalCode, readyAtEnd, readySeconds: connectedSeconds(), ...stats });
      if (!deps.silent && process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
          `## ${config.username} session report`,
          `- Result: **${finalCode === 0 ? 'PASS' : 'FAIL'}**`,
          `- Verified at end: **${readyAtEnd}**`,
          `- Authenticated in-world time: **${connectedSeconds()} seconds**`,
          `- Ready sessions: ${stats.readySessions}; disconnects: ${stats.disconnects}`,
          `- Recoverable timeouts: ${stats.recoverableTimeouts}; auth probes: ${stats.authProbes}`,
          `- Stop reason: \`${reason}\``, ''
        ].join('\n'));
      }
      try { bot?.quit(`${config.username} session finished`); } catch { /* already closed */ }
      setTimeout(() => {
        try { bot?._client?.socket?.destroy(); } catch { /* already closed */ }
        process.off('SIGTERM', onTerm);
        process.off('SIGINT', onInt);
        deps.signal?.removeEventListener('abort', onAbort);
        resolve(finalCode);
      }, 1500);
    }

    function scheduleReady() {
      clearTimeout(settleTimer);
      if (!spawned || !authenticated || ready || recycling || stopping) return;
      const current = bot;
      settleTimer = setTimeout(() => {
        if (stopping || recycling || bot !== current || !spawned || !authenticated || ready) return;
        ready = true;
        readySince = Date.now();
        lastReadyAt = Date.now();
        failures = 0;
        stats.readySessions++;
        log('READY', { username: config.username, version: config.version, authenticated: true, dimension: bot?.game?.dimension });
        writeReport();
      }, 10000);
    }

    function scheduleReconnect() {
      if (stopping || Date.now() >= deadline) return;
      const seconds = Math.max(retryDelaySeconds(++failures, deps.random || Math.random), serverWaitSeconds);
      serverWaitSeconds = 0;
      log('RECONNECT_SCHEDULED', { seconds });
      retryTimer = setTimeout(connect, seconds * 1000);
    }

    function disconnected(current, reason) {
      if (bot !== current) return;
      endReadyPeriod();
      clearConnectionTimers();
      authenticated = false;
      spawned = false;
      recycling = false;
      bot = null;
      if (stopping) return;
      stats.disconnects++;
      log('DISCONNECTED', { reason: plainText(reason).slice(0, 300) });
      writeReport();
      scheduleReconnect();
    }

    function recycleConnection(reason) {
      if (stopping || recycling || !bot) return;
      const current = bot;
      recycling = true;
      wanderer?.stop();
      endReadyPeriod();
      authenticated = false;
      clearConnectionTimers();
      stats.recoverableTimeouts++;
      log('CONNECTION_RETRY', { reason, dimension: current.game?.dimension, terminal: false });
      writeReport();
      // Only recycle this connection. The whole bounded session stays alive.
      forceCloseTimer = setTimeout(() => {
        if (stopping || bot !== current) return;
        try { current._client?.socket?.destroy(); } catch { /* already closed */ }
        disconnected(current, reason);
      }, 2000);
      try { current.quit(reason); } catch { /* force close above */ }
    }

    function sendAuth(current, action, cause) {
      if (stopping || recycling || bot !== current || authenticated) return false;
      if (action === 'login') {
        if (config.expectNewAccount && !registeredHere && !authSent.has('register')) {
          if (cause === 'server_prompt') finish('username_already_registered_password_required', 1);
          return false;
        }
        if (loginAttempts >= 2 || Date.now() - lastLoginAttempt < config.authProbeRepeatSeconds * 1000) return false;
        loginAttempts++;
        lastLoginAttempt = Date.now();
        if (cause === 'missing_auth_notice') stats.authProbes++;
      } else if (authSent.has('register')) return false;
      authSent.add(action);
      log('AUTH_COMMAND', { command: `/${action}`, cause, password: '[REDACTED]' });
      const command = action === 'register' ? `/register ${config.password} ${config.password}` : `/login ${config.password}`;
      try { current.chat(command); }
      catch (error) { log('AUTH_SEND_ERROR', { message: error.message }); recycleConnection('auth_send_failed'); }
      return true;
    }

    function scheduleAuthProbe(current, delaySeconds = config.authProbeDelaySeconds) {
      clearTimeout(authTimer);
      if (stopping || recycling || bot !== current || authenticated || !spawned || loginAttempts >= 2) return;
      if (config.expectNewAccount && !registeredHere && !authSent.has('register')) return;
      authTimer = setTimeout(() => {
        if (stopping || recycling || bot !== current || authenticated || !spawned) return;
        sendAuth(current, 'login', 'missing_auth_notice');
        if (!authenticated && loginAttempts < 2) scheduleAuthProbe(current, config.authProbeRepeatSeconds);
      }, delaySeconds * 1000);
    }

    function connect() {
      if (stopping || Date.now() >= deadline) return;
      clearConnectionTimers();
      stats.attempts++;
      connectionStarted = Date.now();
      authenticated = false;
      spawned = false;
      recycling = false;
      authSent = new Set();
      loginAttempts = 0;
      lastLoginAttempt = -Infinity;
      log('CONNECT', { host: config.host, port: config.port, username: config.username, version: config.version, attempt: stats.attempts });
      let current;
      try {
        current = (deps.createBot || mineflayer.createBot)({
          host: config.host, port: config.port, username: config.username,
          version: config.version, auth: 'offline', viewDistance: 'tiny', respawn: true,
          hideErrors: true, logErrors: false, checkTimeoutInterval: 60000
        });
        bot = current;
      } catch (error) {
        log('CLIENT_CREATION_ERROR', { message: error.message });
        finish('client_creation_failed', 1);
        return;
      }
      current.on('login', () => {
        if (bot !== current || stopping || recycling) return;
        stats.connections++;
        log('LOGIN_PACKET', { username: current.username });
        writeReport();
      });
      current.on('spawn', () => {
        if (bot !== current || stopping || recycling) return;
        spawned = true;
        log('SPAWN', { dimension: current.game?.dimension });
        scheduleReady();
        scheduleAuthProbe(current);
      });
      current.on('messagestr', (message) => {
        if (bot !== current || stopping || recycling) return;
        if (config.authDiagnostics && authDiagnostic(message)) log('AUTH_NOTICE', { notice: plainText(message).slice(0, 300) });
        const action = authAction(message);
        if (action) {
          if (authenticated) {
            endReadyPeriod();
            connectionStarted = Date.now();
            loginAttempts = 0;
            lastLoginAttempt = -Infinity;
          }
          authenticated = false;
          clearTimeout(settleTimer);
          sendAuth(current, action, 'server_prompt');
          scheduleAuthProbe(current);
        } else if (authSucceeded(message)) {
          if (authSent.has('register')) registeredHere = true;
          if (!authenticated) stats.authenticatedConnections++;
          authenticated = true;
          clearTimeout(authTimer);
          log('AUTHENTICATED');
          scheduleReady();
        } else if (authFailed(message)) {
          log('AUTH_FAILED', { notice: plainText(message).slice(0, 300) });
          finish('server_authentication_rejected', 1);
        }
      });
      current.on('death', () => {
        if (!stopping && bot === current) log('DEATH', { automaticRespawn: true });
        // Walking is switched off after a death until an admin moves the bot again.
        wanderer?.disable('death');
      });
      current.on('kicked', (reason) => {
        if (bot !== current || stopping) return;
        log('KICKED', { reason: plainText(reason).slice(0, 500) });
        serverWaitSeconds = Math.max(serverWaitSeconds, serverRetrySeconds(reason));
        if (permanentKick(reason)) finish('server_access_policy_or_authentication', 1);
      });
      current.on('error', (error) => {
        if (bot !== current || stopping) return;
        log('CONNECTION_ERROR', { code: error.code, message: error.message });
        if (/online.mode|microsoft|failed to verify username|invalid session/i.test(error.message)) finish('premium_account_required', 1);
      });
      current.on('end', reason => disconnected(current, reason));
    }

    function onTerm() { finish('SIGTERM', 143); }
    function onInt() { finish('SIGINT', 130); }
    function onAbort() { finish('aborted', 130); }
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    if (deps.signal?.aborted) { onAbort(); return; }
    timers.add(setTimeout(() => finish('duration_reached'), Math.max(0, deadline - Date.now())));
    timers.add(setInterval(() => {
      if (stopping) return;
      log('HEARTBEAT', { ready, authenticated, readySeconds: connectedSeconds(), remainingSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), health: bot?.health, dimension: bot?.game?.dimension });
      writeReport();
    }, 30000));
    timers.add(setInterval(() => {
      if (stopping || ready) return;
      if (bot && !recycling && Date.now() - connectionStarted >= config.joinTimeoutSeconds * 1000) recycleConnection('authentication_or_world_join_timeout');
      // Warn about a long outage, but keep trying until the original deadline.
      if (Date.now() - lastReadyAt >= config.maxOfflineSeconds * 1000 && Date.now() - lastOutageWarning >= config.maxOfflineSeconds * 1000) {
        lastOutageWarning = Date.now();
        log('OUTAGE_WARNING', { offlineSeconds: Math.floor((Date.now() - lastReadyAt) / 1000), continuingUntil: new Date(deadline).toISOString() });
      }
    }, 5000));
    if (wanderer) {
      timers.add(setInterval(() => {
        if (stopping || !ready || !authenticated || !bot || bot.health <= 0) return;
        wanderer.tick();
      }, Math.max(250, config.wanderPauseSeconds * 1000)));
      timers.add(setInterval(() => {
        if (stopping || !ready || !authenticated || !bot || bot.health <= 0) { wanderer.stop(); return; }
        wanderer.monitor();
      }, 250));
    }
    if (config.idleActivitySeconds > 0) timers.add(setInterval(() => {
      if (stopping || !ready || !authenticated || !bot || bot.health <= 0) return;
      try {
        bot.swingArm('right');
        bot.setQuickBarSlot(bot.quickBarSlot === 8 ? 7 : 8);
        stats.activityCount++;
        log('IDLE_ACTIVITY', { action: 'arm_animation_and_slot_change', count: stats.activityCount });
      } catch (error) { log('IDLE_ACTIVITY_ERROR', { message: error.message }); }
    }, config.idleActivitySeconds * 1000));
    log('START', { seconds: config.runSeconds, plannedEndAt: new Date(deadline).toISOString(), idleActivitySeconds: config.idleActivitySeconds, wanderRadiusBlocks: config.wanderRadiusBlocks, minReadySeconds: config.minReadySeconds, auth: 'offline + server password' });
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

'use strict';

function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readConfig(env = process.env) {
  const username = env.MC_USERNAME || 'Sothey';
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) throw new Error('Invalid Minecraft username');
  const password = env.MC_PASSWORD || '';
  if (!/^[^\s\x00-\x1f\x7f]{8,64}$/.test(password)) {
    throw new Error('Set MC_PASSWORD to the bot account password (8–64 characters, no spaces). Never put it in the repository.');
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  const deadlineEpoch = env.BOT_DEADLINE_EPOCH ? integer(env, 'BOT_DEADLINE_EPOCH', 0, nowEpoch + 60, nowEpoch + 86400) : null;
  const runSeconds = deadlineEpoch ? deadlineEpoch - nowEpoch : integer(env, 'BOT_RUN_SECONDS', 14400, 60, 86400);
  const idleActivitySeconds = integer(env, 'BOT_IDLE_ACTIVITY_SECONDS', 45, 0, 300);
  if (idleActivitySeconds > 0 && idleActivitySeconds < 15) throw new Error('Activity interval must be 0 or at least 15 seconds');
  return {
    host: env.MC_HOST || 'exvxeldo.de5.net',
    port: integer(env, 'MC_PORT', 21734, 1, 65535),
    username,
    version: '1.12.2',
    password,
    runSeconds,
    deadlineEpoch,
    authProbeDelaySeconds: integer(env, 'BOT_AUTH_PROBE_DELAY_SECONDS', 12, 5, 60),
    authProbeRepeatSeconds: integer(env, 'BOT_AUTH_PROBE_REPEAT_SECONDS', 30, 15, 120),
    authDiagnostics: env.BOT_AUTH_DIAGNOSTICS === 'true',
    idleActivitySeconds,
    expectNewAccount: env.BOT_EXPECT_NEW_ACCOUNT === 'true',
    minReadySeconds: integer(env, 'BOT_MIN_READY_SECONDS', 30, 1, runSeconds),
    joinTimeoutSeconds: integer(env, 'BOT_JOIN_TIMEOUT_SECONDS', 180, 30, 600),
    maxOfflineSeconds: integer(env, 'BOT_MAX_OFFLINE_SECONDS', 900, 60, 3600)
  };
}

function plainText(value) {
  if (typeof value === 'string') {
    if (['{', '[', '"'].includes(value.trim()[0])) {
      try { return plainText(JSON.parse(value)); } catch { /* ordinary text */ }
    }
    return value.replace(/§[0-9a-fk-or]/gi, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  }
  if (Array.isArray(value)) return value.map(plainText).join('');
  if (value && typeof value === 'object') {
    return [value.text || value.translate || '', ...(value.with || []), ...(value.extra || [])]
      .map(plainText).join(' ');
  }
  return String(value ?? '');
}

// Only recognize known, anchored authentication notices, never arbitrary commands
// or normal player chat. The only commands this program sends are /login and /register.
function authNotice(message) {
  return plainText(message).replace(/^\[(?:AuthMe|Login|Auth)\]\s*/i, '');
}

function authAction(message) {
  const text = authNotice(message);
  if (/^(?:please[,!]?\s*)?(?:register\b|registration\b|пожалуйста[,!]?\s*зарегистрируйтесь|зарегистрируйтесь|для регистрации)[^\n]*\/register\b/i.test(text)) return 'register';
  if (/^(?:please[,!]?\s*)?(?:login\b|log in\b|пожалуйста[,!]?\s*(?:войдите|авторизуйтесь)|войдите|авторизуйтесь|для входа)[^\n]*\/login\b/i.test(text)) return 'login';
  return null;
}

function authSucceeded(message) {
  return /^(?:successfully registered|successful login|login successful|registration successful|(?:you are |you['’]re )?already logged in|you have (?:been )?(?:successfully |automatically )?(?:logged in|registered)|вы (?:были )?(?:успешно |автоматически )?(?:зарегистрировались|зарегистрированы|вошли|авторизовались)|успешная (?:авторизация|регистрация)|вы успешно прошли авторизацию|вы уже (?:авторизованы|авторизовались|вошли(?: в систему)?))(?:[!.\s]|$)/i.test(authNotice(message));
}

function authFailed(message) {
  return /^(?:wrong password|incorrect password|invalid password|неверный пароль|неправильный пароль|registration (?:is )?(?:disabled|blocked)|registrations? (?:are )?not allowed|you have (?:exceeded|reached) the (?:maximum|max)|(?:your )?password (?:is )?too (?:short|long)|пароль слишком|регистрация (?:отключена|запрещена))/i.test(authNotice(message));
}

function authDiagnostic(message) {
  const text = plainText(message);
  if (/^<|»/.test(text)) return false;
  return /^(?:\[(?:AuthMe|Login|Auth)\]\s*)?(?:please|you |you're |already |unknown command|this command|not registered|login|registration|password|success|вы |пожалуйста|неизвестная команда|сервер|server|limbo)/i.test(text)
    && /login|log in|logged|auth|register|password|парол|авториз|команд|неизвест|unknown|server|сервер|limbo/i.test(text);
}

function permanentKick(reason) {
  return /\bbanned\b|not white[ -]?listed|not on the white[ -]?list|you are not allowed|whitelist|забан|бел(?:ый|ом) спис|captcha|anti[ -]?bot|already (?:connected|logged in)|logged in from another location|другого места|wrong password|incorrect password|неверный пароль|kicked for (?:idling|being idle|being afk)|слишком долго бездейств|multiplayer\.disconnect\.(?:banned|not_whitelisted|duplicate_login|idling)/i.test(plainText(reason));
}

function serverRetrySeconds(reason) {
  const match = plainText(reason).match(/wait\s+(\d{1,4})\s+seconds?\s+before\s+(?:logging.in|joining)/i);
  return match ? Math.min(3600, Number(match[1]) + 2) : 0;
}

function retryDelaySeconds(failures, random = Math.random) {
  return Math.min(120, 15 * 2 ** Math.min(3, Math.max(0, failures - 1)) + Math.floor(random() * 5));
}

function redact(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
}

module.exports = { readConfig, plainText, authAction, authSucceeded, authFailed, authDiagnostic, permanentKick, serverRetrySeconds, retryDelaySeconds, redact };

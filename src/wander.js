'use strict';

// Continuous, bounded walking around an anchor point, with an occasional jump.
// Ordinary player movement packets only: no teleports, no flying, no speed
// changes, no chat, no interaction.
//
// The owner built a safe platform around the bot, so this deliberately does NOT
// sample terrain. The only rule is the radius, decided by the block the bot
// appeared on: gold ore means the tight survival spawn platform, anything else
// the normal area.

const GOLD_ORE_RADIUS = 2;
const DEFAULT_RADIUS = 5;

const round = value => Math.round(value * 100) / 100;

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isGoldOre(block) {
  return !!block && /gold_ore$/.test(block.name);
}

function blockUnder(bot, x, y, z) {
  return bot.blockAt(Math.floor(x), Math.floor(y) - 1, Math.floor(z));
}

function radiusFor(bot, position, configuredRadius, pinned) {
  // An explicitly pinned anchor means the owner chose both the point and the radius.
  if (pinned) return { radius: configuredRadius, goldOre: false, block: null, pinned: true };
  const block = blockUnder(bot, position.x, position.y, position.z);
  const goldOre = isGoldOre(block);
  return { radius: goldOre ? GOLD_ORE_RADIUS : configuredRadius, goldOre, block: block ? block.name : null, pinned: false };
}

// Walk back towards the anchor instead of giving up when the bot ends up outside.
function homingTarget(anchor, radius, position) {
  const dx = anchor.x - position.x;
  const dz = anchor.z - position.z;
  const distance = Math.hypot(dx, dz) || 1;
  const step = Math.min(distance, Math.max(2, radius * 0.6));
  return { x: position.x + (dx / distance) * step, z: position.z + (dz / distance) * step };
}

// A target that is too close makes the leg finish instantly, so the bot would
// stand still. Resample a few times for a target at least minStep away.
function pickTarget(anchor, radius, from = null, random = Math.random, minStep = 1.5) {
  let fallback = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = radius * (0.35 + random() * 0.65);
    const target = { x: anchor.x + Math.cos(angle) * distance, z: anchor.z + Math.sin(angle) * distance };
    if (!from || distance2D(from, target) >= minStep) return target;
    fallback = target;
  }
  return fallback;
}

// Minecraft yaw: 0 faces +Z (south), -pi/2 faces +X (east).
function yawTowards(from, to) {
  return Math.atan2(-(to.x - from.x), to.z - from.z);
}

function createWanderer({
  getBot, anchor: initialAnchor = null, radius: configuredRadius = DEFAULT_RADIUS,
  random = Math.random, log = () => {},
  pauseMs = 1000, maxLegMs = 4000, jumpEveryLegs = 3, jumpDelayMs = 800, jumpHoldMs = 300,
  teleportReanchorBlocks = 8, maxHomingBlocks = 200, now = () => Date.now()
}) {
  const pinned = initialAnchor !== null;
  let anchor = initialAnchor;
  let radius = pinned ? configuredRadius : null;
  let disabled = false;
  let leg = null;
  let lastPosition = null;
  let pauseUntil = 0;
  let legIndex = 0;
  const stats = { legs: 0, jumps: 0, movedBlocks: 0, reanchors: 0, stops: {} };

  function release() {
    const bot = getBot();
    if (bot && leg) {
      try {
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
      } catch { /* connection gone */ }
    }
    leg = null;
  }

  function note(reason) {
    stats.stops[reason] = (stats.stops[reason] || 0) + 1;
  }

  function setAnchorFrom(position, reason) {
    if (pinned) {
      radius = configuredRadius;
      disabled = false;
      log('WANDER_ANCHOR', { x: anchor.x, y: anchor.y, z: anchor.z, reason, pinned: true });
      log('WANDER_RADIUS', { radius, pinned: true });
      return;
    }
    anchor = { x: Math.floor(position.x) + 0.5, y: Math.floor(position.y), z: Math.floor(position.z) + 0.5 };
    const chosen = radiusFor(getBot(), position, configuredRadius, pinned);
    radius = chosen.radius;
    disabled = false;
    log('WANDER_ANCHOR', { x: anchor.x, y: anchor.y, z: anchor.z, reason, pinned: false });
    log('WANDER_RADIUS', { radius, goldOre: chosen.goldOre, block: chosen.block, pinned: false });
  }

  function tick() {
    const bot = getBot();
    if (!bot || !bot.entity || !bot.entity.position || disabled) return;
    const position = bot.entity.position;
    if (!anchor) setAnchorFrom(position, 'spawn');
    if (leg || now() < pauseUntil) return;
    if (!bot.entity.onGround) return;
    const away = distance2D(position, anchor);
    const homing = away > radius;
    const target = homing ? homingTarget(anchor, radius, position) : pickTarget(anchor, radius, position, random);
    legIndex++;
    leg = {
      target, homing, index: legIndex, endsAt: now() + maxLegMs, start: { x: position.x, z: position.z },
      jumpState: jumpEveryLegs > 0 && legIndex % jumpEveryLegs === 0 ? 'pending' : 'none',
      jumpAt: now() + jumpDelayMs, jumpUntil: 0
    };
    stats.legs++;
    try {
      const looking = bot.look(yawTowards(position, target), 0, true);
      if (looking && typeof looking.catch === 'function') looking.catch(() => {/* best effort */});
      bot.setControlState('forward', true);
      log('WANDER_LEG_START', { leg: legIndex, target: { x: round(target.x), z: round(target.z) }, radius, homing, jump: leg.jumpState === 'pending' });
    } catch (error) {
      release();
      log('WANDER_ERROR', { message: error.message });
    }
  }

  function monitor() {
    const bot = getBot();
    if (!bot || !bot.entity || !bot.entity.position) return;
    const position = bot.entity.position;
    // An admin teleport is the only legitimate way the anchor should move.
    if (lastPosition && anchor) {
      const jump = distance2D(position, lastPosition);
      if (jump > teleportReanchorBlocks) {
        release();
        if (pinned) {
          // The owner pinned this point, so the bot walks back instead of re-anchoring.
          log('WANDER_TELEPORTED', { jump: round(jump), pinned: true });
        } else {
          setAnchorFrom(position, 'teleport');
          stats.reanchors++;
          log('WANDER_REANCHORED', { jump: round(jump) });
        }
      }
    }
    lastPosition = { x: position.x, y: position.y, z: position.z };
    if (!leg) return;

    if (leg.jumpState === 'pending' && now() >= leg.jumpAt) {
      try { bot.setControlState('jump', true); } catch { /* ignore */ }
      leg.jumpState = 'active';
      leg.jumpUntil = now() + jumpHoldMs;
      stats.jumps++;
      log('WANDER_JUMP', { leg: leg.index });
    } else if (leg.jumpState === 'active' && now() >= leg.jumpUntil) {
      try { bot.setControlState('jump', false); } catch { /* ignore */ }
      leg.jumpState = 'done';
    }

    const away = distance2D(position, anchor);
    // A homing leg is allowed to start outside the radius; that is how it returns.
    if (!leg.homing && away > radius + 1.5) {
      release();
      note('out_of_range');
      log('WANDER_STOPPED', { reason: 'out_of_range', distance: round(away), radius, legs: stats.legs });
      return;
    }
    if (leg.homing && away > maxHomingBlocks) {
      release();
      note('too_far_to_return');
      log('WANDER_STOPPED', { reason: 'too_far_to_return', distance: round(away), radius });
      return;
    }

    if (distance2D(position, leg.target) < 0.7 || now() >= leg.endsAt) {
      const moved = round(distance2D(leg.start, position));
      release();
      stats.movedBlocks = round(stats.movedBlocks + moved);
      pauseUntil = now() + pauseMs;
      log('WANDER_LEG_END', { leg: legIndex, moved, legs: stats.legs, jumps: stats.jumps });
    }
  }

  function reset() {
    release();
    anchor = initialAnchor;
    radius = null;
    lastPosition = null;
    pauseUntil = 0;
  }

  return {
    tick, monitor, reset,
    stop: release,
    disable: reason => { release(); disabled = true; log('WANDER_DISABLED', { reason }); },
    getAnchor: () => (anchor ? { ...anchor } : null),
    getRadius: () => radius,
    getStats: () => ({ ...stats, stops: { ...stats.stops } }),
    isDisabled: () => disabled,
    isMoving: () => !!leg
  };
}

module.exports = { GOLD_ORE_RADIUS, DEFAULT_RADIUS, distance2D, blockUnder, isGoldOre, radiusFor, homingTarget, pickTarget, yawTowards, createWanderer };

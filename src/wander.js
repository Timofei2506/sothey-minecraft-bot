'use strict';

// Short, bounded walking around an anchor point. Ordinary player movement packets
// only: no teleports, no flying, no speed changes, no chat, no interaction.
//
// The owner built a safe platform around the bot, so this deliberately does NOT
// sample terrain: the only rule is the radius. The block the bot appeared on
// decides it — gold ore means the tight survival spawn platform, anything else
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

// Decided once, from the block the bot appeared on.
function radiusFor(bot, position) {
  const block = blockUnder(bot, position.x, position.y, position.z);
  const goldOre = isGoldOre(block);
  return { radius: goldOre ? GOLD_ORE_RADIUS : DEFAULT_RADIUS, goldOre, block: block ? block.name : null };
}

function pickTarget(anchor, radius, random = Math.random) {
  const angle = random() * Math.PI * 2;
  const distance = radius * (0.35 + random() * 0.65);
  return { x: anchor.x + Math.cos(angle) * distance, z: anchor.z + Math.sin(angle) * distance };
}

// Minecraft yaw: 0 faces +Z (south), -pi/2 faces +X (east).
function yawTowards(from, to) {
  return Math.atan2(-(to.x - from.x), to.z - from.z);
}

function createWanderer({
  getBot, anchor: initialAnchor = null, random = Math.random, log = () => {},
  maxLegMs = 4000, teleportReanchorBlocks = 8, now = () => Date.now()
}) {
  let anchor = initialAnchor;
  let radius = null;
  let disabled = false;
  let leg = null;
  let lastPosition = null;

  function release() {
    const bot = getBot();
    if (bot && leg) {
      try { bot.setControlState('forward', false); } catch { /* connection gone */ }
    }
    leg = null;
  }

  function setAnchorFrom(position, reason) {
    anchor = { x: Math.floor(position.x) + 0.5, y: Math.floor(position.y), z: Math.floor(position.z) + 0.5 };
    const chosen = radiusFor(getBot(), position);
    radius = chosen.radius;
    disabled = false;
    log('WANDER_ANCHOR', { x: anchor.x, y: anchor.y, z: anchor.z, reason });
    log('WANDER_RADIUS', { radius, goldOre: chosen.goldOre, block: chosen.block });
  }

  function tick() {
    const bot = getBot();
    if (!bot || !bot.entity || !bot.entity.position || disabled) return;
    const position = bot.entity.position;
    if (!anchor) setAnchorFrom(position, 'spawn');
    if (leg) return;
    if (!bot.entity.onGround) return;
    const target = pickTarget(anchor, radius, random);
    leg = { target, endsAt: now() + maxLegMs, start: { x: position.x, z: position.z } };
    try {
      const looking = bot.look(yawTowards(position, target), 0, true);
      if (looking && typeof looking.catch === 'function') looking.catch(() => {/* best effort */});
      bot.setControlState('forward', true);
      log('WANDER_LEG_START', { target: { x: round(target.x), z: round(target.z) }, radius, maxSeconds: maxLegMs / 1000 });
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
        setAnchorFrom(position, 'teleport');
        log('WANDER_REANCHORED', { jump: round(jump) });
      }
    }
    lastPosition = { x: position.x, y: position.y, z: position.z };
    if (!leg) return;
    // Stay inside the agreed radius; stop early if something pushed the bot out.
    if (distance2D(position, anchor) > radius + 1.5) {
      release();
      log('WANDER_STOPPED', { reason: 'out_of_range', distance: round(distance2D(position, anchor)), radius });
      return;
    }
    if (distance2D(position, leg.target) < 0.7 || now() >= leg.endsAt) {
      const moved = round(distance2D(leg.start, position));
      release();
      log('WANDER_LEG_END', { moved });
    }
  }

  function reset() {
    release();
    anchor = initialAnchor;
    radius = null;
    lastPosition = null;
  }

  return {
    tick, monitor, reset,
    stop: release,
    disable: reason => { release(); disabled = true; log('WANDER_DISABLED', { reason }); },
    getAnchor: () => (anchor ? { ...anchor } : null),
    getRadius: () => radius,
    isDisabled: () => disabled,
    isMoving: () => !!leg
  };
}

module.exports = { GOLD_ORE_RADIUS, DEFAULT_RADIUS, distance2D, blockUnder, isGoldOre, radiusFor, pickTarget, yawTowards, createWanderer };

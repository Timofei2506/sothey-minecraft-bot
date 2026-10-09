'use strict';

// Short, bounded walking around an anchor point. Ordinary player movement packets
// only: no teleports, no flying, no speed changes, no chat, no interaction.
const HAZARDS = new Set([
  'lava', 'flowing_lava', 'fire', 'cactus', 'magma_block', 'sweet_berry_bush',
  'water', 'flowing_water', 'nether_portal', 'end_portal', 'end_gateway'
]);

const round = value => Math.round(value * 100) / 100;

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function solidStanding(block) {
  return !!block && block.boundingBox === 'block' && block.name !== 'air' && !HAZARDS.has(block.name);
}

function clearSpace(block) {
  return !block || block.name === 'air' || block.boundingBox === 'empty';
}

function isSafeStanding(bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return false;
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  if (!solidStanding(bot.blockAt(bx, by - 1, bz))) return false;
  return clearSpace(bot.blockAt(bx, by, bz)) && clearSpace(bot.blockAt(bx, by + 1, bz));
}

function blockUnder(bot, x, y, z) {
  return bot.blockAt(Math.floor(x), Math.floor(y) - 1, Math.floor(z));
}

function isGoldOre(block) {
  return !!block && /gold_ore$/.test(block.name);
}

// Sample a disc around the anchor. Any unsafe sample makes this radius unusable.
function unsafeSample(bot, anchor, radius) {
  if (!Number.isFinite(radius) || radius <= 0) return { x: anchor.x, y: anchor.y, z: anchor.z, reason: 'invalid_radius' };
  if (!isSafeStanding(bot, anchor.x, anchor.y, anchor.z)) return { x: anchor.x, y: anchor.y, z: anchor.z, reason: 'anchor' };
  const directions = 8;
  for (const distance of [radius * 0.5, radius]) {
    for (let index = 0; index < directions; index++) {
      const angle = (index / directions) * Math.PI * 2;
      const x = anchor.x + Math.cos(angle) * distance;
      const z = anchor.z + Math.sin(angle) * distance;
      if (!isSafeStanding(bot, x, anchor.y, z)) return { x: round(x), y: anchor.y, z: round(z), reason: 'sample' };
    }
  }
  return null;
}

function areaIsSafe(bot, anchor, radius) {
  return unsafeSample(bot, anchor, radius) === null;
}

// Gold ore marks the survival spawn platform, which has void close by. The owner
// asked for the radius to be reduced by two blocks there. On top of that the
// radius keeps shrinking until the sampled area is actually safe.
function resolveRadius(bot, anchor, configuredRadius) {
  let radius = configuredRadius;
  const goldOre = isGoldOre(blockUnder(bot, anchor.x, anchor.y, anchor.z));
  if (goldOre) radius = Math.max(1, radius - 2);
  while (radius > 1 && unsafeSample(bot, anchor, radius) !== null) radius -= 1;
  if (unsafeSample(bot, anchor, radius) !== null) return { radius: 0, goldOre, unsafe: unsafeSample(bot, anchor, radius) };
  return { radius, goldOre, unsafe: null };
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

function playerTooClose(bot, position, distance = 2) {
  if (!bot.players) return false;
  return Object.values(bot.players).some(player => {
    const other = player?.entity?.position;
    return other && distance2D(other, position) < distance;
  });
}

function createWanderer({
  getBot, radius: configuredRadius, anchor: initialAnchor = null, random = Math.random, log = () => {},
  maxLegMs = 4000, teleportReanchorBlocks = 8, probeAheadBlocks = 1, now = () => Date.now()
}) {
  let anchor = initialAnchor;
  let activeRadius = null;
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

  function invalidate() {
    activeRadius = null;
  }

  function setAnchorFrom(position, reason) {
    anchor = { x: Math.floor(position.x) + 0.5, y: Math.floor(position.y), z: Math.floor(position.z) + 0.5 };
    invalidate();
    disabled = false;
    log('WANDER_ANCHOR', { x: anchor.x, y: anchor.y, z: anchor.z, configuredRadius, reason });
  }

  function tick() {
    const bot = getBot();
    if (!bot || !bot.entity || !bot.entity.position || configuredRadius <= 0 || disabled) return;
    const position = bot.entity.position;
    if (!anchor) setAnchorFrom(position, 'start');
    if (leg) return;
    if (activeRadius === null) {
      const resolved = resolveRadius(bot, anchor, configuredRadius);
      if (resolved.radius === 0) {
        disabled = true;
        log('WANDER_DISABLED_UNSAFE_AREA', { configuredRadius, goldOre: resolved.goldOre, point: resolved.unsafe });
        return;
      }
      activeRadius = resolved.radius;
      log('WANDER_RADIUS', { configured: configuredRadius, effective: activeRadius, goldOre: resolved.goldOre });
    }
    if (!bot.entity.onGround) return;
    if (distance2D(position, anchor) > activeRadius + 1) {
      disabled = true;
      log('WANDER_DISABLED_OUT_OF_RANGE', { distance: round(distance2D(position, anchor)), radius: activeRadius });
      return;
    }
    if (!isSafeStanding(bot, position.x, position.y, position.z)) return;
    if (playerTooClose(bot, position)) {
      log('WANDER_SKIPPED_PLAYER_NEARBY');
      return;
    }
    const target = pickTarget(anchor, activeRadius, random);
    if (!isSafeStanding(bot, target.x, position.y, target.z)) {
      log('WANDER_SKIPPED_UNSAFE_TARGET', { x: round(target.x), z: round(target.z) });
      return;
    }
    leg = { target, endsAt: now() + maxLegMs, startHealth: bot.health ?? 20, startY: position.y, start: { x: position.x, z: position.z } };
    try {
      const looking = bot.look(yawTowards(position, target), 0, true);
      if (looking && typeof looking.catch === 'function') looking.catch(() => {/* best effort */});
      bot.setControlState('forward', true);
      log('WANDER_LEG_START', { target: { x: round(target.x), z: round(target.z) }, maxSeconds: maxLegMs / 1000, radius: activeRadius });
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
      if (jump > teleportReanchorBlocks && bot.entity.onGround && isSafeStanding(bot, position.x, position.y, position.z)) {
        release();
        setAnchorFrom(position, 'teleport');
        log('WANDER_REANCHORED', { jump: round(jump) });
      }
    }
    lastPosition = { x: position.x, y: position.y, z: position.z };
    if (!leg) return;
    const abort = (reason, data = {}) => {
      release();
      invalidate();
      log('WANDER_STOPPED', { reason, ...data });
    };
    if (bot.health !== undefined && bot.health < leg.startHealth) return abort('damage', { health: bot.health });
    if (leg.startY - position.y > 1.5) return abort('falling', { drop: round(leg.startY - position.y) });
    if (distance2D(position, anchor) > activeRadius + 1.5) return abort('out_of_range', { distance: round(distance2D(position, anchor)) });
    if (!isSafeStanding(bot, position.x, position.y, position.z)) return abort('unsafe_standing');
    // Look one block ahead so the bot stops before a hole, not after entering it.
    const dx = leg.target.x - position.x;
    const dz = leg.target.z - position.z;
    const length = Math.hypot(dx, dz) || 1;
    const probeX = position.x + (dx / length) * probeAheadBlocks;
    const probeZ = position.z + (dz / length) * probeAheadBlocks;
    if (!isSafeStanding(bot, probeX, position.y, probeZ)) return abort('unsafe_ahead', { x: round(probeX), z: round(probeZ) });
    if (distance2D(position, leg.target) < 0.7 || now() >= leg.endsAt) {
      // Read the distance before releasing, which clears the leg.
      const moved = round(distance2D(leg.start, position));
      release();
      log('WANDER_LEG_END', { moved });
    }
  }

  function reset() {
    release();
    anchor = initialAnchor;
    invalidate();
    lastPosition = null;
  }

  return {
    tick, monitor, reset,
    stop: release,
    disable: reason => { release(); disabled = true; log('WANDER_DISABLED', { reason }); },
    getAnchor: () => (anchor ? { ...anchor } : null),
    getRadius: () => activeRadius,
    isDisabled: () => disabled,
    isMoving: () => !!leg
  };
}

module.exports = { HAZARDS, distance2D, solidStanding, isSafeStanding, blockUnder, isGoldOre, unsafeSample, areaIsSafe, resolveRadius, pickTarget, yawTowards, playerTooClose, createWanderer };

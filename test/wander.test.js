'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distance2D, isSafeStanding, unsafeSample, areaIsSafe, resolveRadius, pickTarget, yawTowards, playerTooClose, createWanderer } = require('../src/wander');

function flatWorld({ groundY = 63, overrides = new Map(), platformRadius = Infinity } = {}) {
  return {
    block(x, y, z) {
      const key = `${x},${y},${z}`;
      if (overrides.has(key)) return overrides.get(key);
      const solid = y === groundY && Math.hypot(x - 0, z - 0) <= platformRadius;
      return solid ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    }
  };
}

function makeBot({ world = flatWorld(), position = { x: 0.5, y: 64, z: 0.5 }, health = 20, onGround = true, players = {} } = {}) {
  const state = { health, controls: {}, looks: [], onGround };
  return {
    state,
    players,
    entity: {
      get position() { return position; },
      get onGround() { return state.onGround; }
    },
    get health() { return state.health; },
    blockAt: (x, y, z) => world.block(Math.floor(x), Math.floor(y), Math.floor(z)),
    setControlState(name, value) { state.controls[name] = value; },
    look(yaw, pitch, force) { state.looks.push(yaw); return Promise.resolve(); },
    moveTo(x, y, z) { position = { x, y, z }; }
  };
}

function harness(options = {}) {
  const events = [];
  const bot = options.bot || makeBot(options);
  const wanderer = createWanderer({
    getBot: () => bot,
    radius: options.radius ?? 5,
    anchor: options.anchor ?? null,
    random: options.random || (() => 0),
    log: (event, data = {}) => events.push({ event, ...data }),
    now: () => options.now ?? 0
  });
  return { bot, wanderer, events, names: () => events.map(e => e.event), last: name => events.filter(e => e.event === name).pop() };
}

test('yaw follows the Minecraft convention and targets stay inside the radius', () => {
  assert.ok(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 0, z: 1 })) < 0.01);
  assert.ok(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 1, z: 0 }) + Math.PI / 2) < 0.01);
  assert.ok(Math.abs(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 0, z: -1 })) - Math.PI) < 0.01);
  const anchor = { x: 10, y: 64, z: -3 };
  for (let i = 0; i < 50; i++) {
    const target = pickTarget(anchor, 5, Math.random);
    assert.ok(distance2D(anchor, target) <= 5);
  }
});

test('standing is unsafe over air, lava or without headroom', () => {
  const bot = makeBot();
  assert.equal(isSafeStanding(bot, 0.5, 64, 0.5), true);
  assert.equal(isSafeStanding(bot, 0.5, 70, 0.5), false); // no ground below
  const lava = flatWorld({ overrides: new Map([['0,63,0', { name: 'lava', boundingBox: 'block' }]]) });
  assert.equal(isSafeStanding(makeBot({ world: lava }), 0.5, 64, 0.5), false);
  const blocked = flatWorld({ overrides: new Map([['0,64,0', { name: 'stone', boundingBox: 'block' }]]) });
  assert.equal(isSafeStanding(makeBot({ world: blocked }), 0.5, 64, 0.5), false);
});

test('a gold-ore spawn platform shrinks the radius by two blocks', () => {
  const overrides = new Map([['0,63,0', { name: 'gold_ore', boundingBox: 'block' }]]);
  const bot = makeBot({ world: flatWorld({ overrides }) });
  const resolved = resolveRadius(bot, { x: 0.5, y: 64, z: 0.5 }, 5);
  assert.equal(resolved.goldOre, true);
  assert.equal(resolved.radius, 3);
});

test('the radius keeps shrinking until the sampled area is actually safe', () => {
  // Solid ground only within 3.5 blocks; void beyond.
  const bot = makeBot({ world: flatWorld({ platformRadius: 3.5 }) });
  const resolved = resolveRadius(bot, { x: 0.5, y: 64, z: 0.5 }, 5);
  assert.equal(resolved.goldOre, false);
  assert.equal(resolved.radius, 3);
  assert.equal(areaIsSafe(bot, { x: 0.5, y: 64, z: 0.5 }, resolved.radius), true);
  assert.equal(areaIsSafe(bot, { x: 0.5, y: 64, z: 0.5 }, 5), false);
});

test('with void right next to the anchor walking is disabled, with a little room it still shrinks to one block', () => {
  const tiny = makeBot({ world: flatWorld({ platformRadius: 0.5 }) });
  const first = harness({ bot: tiny, radius: 5 });
  first.wanderer.tick();
  assert.equal(first.wanderer.isDisabled(), true);
  assert.equal(first.last('WANDER_DISABLED_UNSAFE_AREA').configuredRadius, 5);
  assert.equal(tiny.state.controls.forward, undefined);

  const small = makeBot({ world: flatWorld({ platformRadius: 1.5 }) });
  const second = harness({ bot: small, radius: 5 });
  second.wanderer.tick();
  assert.equal(second.wanderer.isDisabled(), false);
  assert.equal(second.wanderer.getRadius(), 1);
  assert.equal(small.state.controls.forward, true);
});

test('a full wander leg starts, walks and releases movement', () => {
  const bot = makeBot();
  const h = harness({ bot, radius: 5, random: () => 0 });
  h.wanderer.tick();
  assert.equal(h.wanderer.getRadius(), 5);
  assert.equal(bot.state.controls.forward, true);
  assert.equal(h.last('WANDER_LEG_START').radius, 5);
  bot.moveTo(2.0, 64, 0.5);
  h.wanderer.monitor();
  assert.equal(bot.state.controls.forward, false);
  assert.ok(h.last('WANDER_LEG_END').moved > 0);
});

test('movement stops before a hole one block ahead', () => {
  // One hole in the floor at block (1, 63, 0), inside an otherwise safe area.
  const bot = makeBot({ world: flatWorld({ overrides: new Map([['1,63,0', { name: 'air', boundingBox: 'empty' }]]) }) });
  const h = harness({ bot, radius: 5, random: () => 0 });
  h.wanderer.tick();
  assert.equal(bot.state.controls.forward, true);
  h.wanderer.monitor();
  assert.equal(bot.state.controls.forward, false);
  assert.equal(h.last('WANDER_STOPPED').reason, 'unsafe_ahead');
});

test('falling, damage and leaving the radius stop the leg', () => {
  const falling = harness({ radius: 5 });
  falling.wanderer.tick();
  falling.bot.moveTo(0.5, 62, 0.5);
  falling.wanderer.monitor();
  falling.wanderer.monitor();
  assert.equal(falling.last('WANDER_STOPPED').reason, 'falling');

  const hurt = harness({ radius: 5 });
  hurt.wanderer.tick();
  hurt.bot.state.health = 12;
  hurt.wanderer.monitor();
  assert.equal(hurt.last('WANDER_STOPPED').reason, 'damage');

  const far = harness({ radius: 5 });
  far.wanderer.tick();
  far.bot.moveTo(9, 64, 0.5);
  far.wanderer.monitor();
  assert.equal(far.last('WANDER_STOPPED').reason, 'out_of_range');
});

test('wandering does not start while another player stands nearby', () => {
  const bot = makeBot({ players: { Steve: { entity: { position: { x: 1.4, y: 64, z: 0.5 } } } } });
  const h = harness({ bot, radius: 5 });
  h.wanderer.tick();
  assert.equal(h.last('WANDER_SKIPPED_PLAYER_NEARBY') !== undefined, true);
  assert.equal(bot.state.controls.forward, undefined);
  assert.equal(playerTooClose(bot, { x: 0.5, z: 0.5 }), true);
  assert.equal(playerTooClose(bot, { x: 20, z: 20 }), false);
});

test('an admin teleport re-anchors and re-enables walking', () => {
  const bot = makeBot();
  const h = harness({ bot, radius: 5 });
  h.wanderer.tick();
  h.wanderer.monitor();
  assert.equal(h.wanderer.getAnchor().x, 0.5);
  bot.moveTo(120.5, 64, 40.5);
  h.wanderer.monitor();
  assert.equal(h.last('WANDER_REANCHORED').jump, 126.49);
  assert.deepEqual(h.wanderer.getAnchor(), { x: 120.5, y: 64, z: 40.5 });
  h.wanderer.tick();
  assert.equal(h.last('WANDER_RADIUS').effective, 5);
});

test('a death disables walking until an admin teleports the bot again', () => {
  const bot = makeBot();
  const h = harness({ bot, radius: 5 });
  h.wanderer.tick();
  h.wanderer.monitor();
  const legsBefore = h.events.filter(e => e.event === 'WANDER_LEG_START').length;
  h.wanderer.disable('death');
  assert.equal(h.wanderer.isDisabled(), true);
  h.wanderer.tick();
  assert.equal(h.events.filter(e => e.event === 'WANDER_LEG_START').length, legsBefore);
  assert.equal(bot.state.controls.forward, false);
  bot.moveTo(300.5, 64, 300.5);
  h.wanderer.monitor();
  h.wanderer.monitor();
  h.wanderer.tick();
  assert.equal(h.wanderer.isDisabled(), false);
  assert.equal(h.last('WANDER_LEG_START') !== undefined, true);
});

test('an explicitly configured anchor is honoured and a zero radius never walks', () => {
  const bot = makeBot();
  const h = harness({ bot, radius: 0, anchor: { x: 4, y: 64, z: 4 } });
  h.wanderer.tick();
  assert.equal(bot.state.controls.forward, undefined);
  assert.equal(h.last('WANDER_LEG_START'), undefined);
  const anchored = harness({ bot, radius: 5, anchor: { x: 4, y: 64, z: 4 } });
  anchored.wanderer.tick();
  assert.deepEqual(anchored.wanderer.getAnchor(), { x: 4, y: 64, z: 4 });
});

test('unsafeSample reports the offending point for diagnosis', () => {
  const bot = makeBot({ world: flatWorld({ platformRadius: 2.5 }) });
  const point = unsafeSample(bot, { x: 0.5, y: 64, z: 0.5 }, 5);
  assert.equal(point.reason, 'sample');
  assert.ok(Math.hypot(point.x, point.z) > 2.5);
  assert.equal(unsafeSample(bot, { x: 0.5, y: 80, z: 0.5 }, 5).reason, 'anchor');
});

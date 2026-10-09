'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distance2D, radiusFor, pickTarget, yawTowards, homingTarget, isGoldOre, createWanderer } = require('../src/wander');

function block(name) {
  return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
}

function worldAt(ground = 'stone') {
  const nameAt = typeof ground === 'function' ? ground : () => ground;
  return { block: (x, y, z) => (y === 63 ? block(nameAt(x, y, z)) : block('air')) };
}

function makeBot({ ground = 'stone', position = { x: 0.5, y: 64, z: 0.5 }, health = 20, onGround = true } = {}) {
  const state = { health, controls: {}, looks: [], onGround };
  const world = worldAt(ground);
  return {
    state,
    entity: { get position() { return position; }, get onGround() { return state.onGround; } },
    get health() { return state.health; },
    blockAt: (x, y, z) => world.block(Math.floor(x), Math.floor(y), Math.floor(z)),
    setControlState(name, value) { state.controls[name] = value; },
    look(yaw, pitch, force) { state.looks.push(yaw); return Promise.resolve(); },
    moveTo(x, y, z) { position = { x, y, z }; }
  };
}

function harness(options = {}) {
  const events = [];
  const clock = { t: 0 };
  const bot = options.bot || makeBot(options);
  const wanderer = createWanderer({
    getBot: () => bot,
    anchor: options.anchor ?? null,
    random: options.random || (() => 0),
    log: (event, data = {}) => events.push({ event, ...data }),
    radius: options.radius ?? 5,
    pauseMs: options.pauseMs ?? 0,
    jumpEveryLegs: options.jumpEveryLegs ?? 3,
    jumpDelayMs: options.jumpDelayMs ?? 0,
    jumpHoldMs: options.jumpHoldMs ?? 100,
    maxLegMs: options.maxLegMs ?? 4000,
    now: () => clock.t
  });
  return { bot, wanderer, events, clock, last: name => events.filter(e => e.event === name).pop() };
}

function endLeg(h, at) {
  h.wanderer.monitor();
  h.clock.t += 10;
}

test('the radius is 2 over gold ore and 5 over any other block', () => {
  const at = { x: 0.5, y: 64, z: 0.5 };
  assert.equal(radiusFor(makeBot({ ground: 'gold_ore' }), at, 5, false).radius, 2);
  assert.equal(radiusFor(makeBot({ ground: 'stone' }), at, 5, false).radius, 5);
  assert.equal(radiusFor(makeBot({ ground: 'grass' }), at, 5, false).radius, 5);
  assert.equal(radiusFor(makeBot({ ground: 'gold_ore' }), at, 5, true).radius, 5, 'pinned wins');
  assert.equal(isGoldOre({ name: 'gold_ore' }), true);
  assert.equal(isGoldOre({ name: 'nether_gold_ore' }), true);
  assert.equal(isGoldOre({ name: 'stone' }), false);
  assert.equal(isGoldOre(null), false);
});

test('walking starts without terrain checks and uses the spawn block radius', () => {
  const bot = makeBot({ ground: 'gold_ore' });
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  assert.equal(h.wanderer.getRadius(), 2);
  assert.equal(h.last('WANDER_RADIUS').goldOre, true);
  assert.equal(h.last('WANDER_RADIUS').block, 'gold_ore');
  assert.equal(bot.state.controls.forward, true);
  assert.equal(h.last('WANDER_LEG_START').radius, 2);
});

test('legs chain back to back so the bot keeps moving', () => {
  const bot = makeBot();
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  assert.equal(h.last('WANDER_LEG_START').leg, 1);
  bot.moveTo(2.0, 64, 0.5);
  h.wanderer.monitor();
  assert.equal(bot.state.controls.forward, false);
  h.wanderer.tick();
  assert.equal(h.last('WANDER_LEG_START').leg, 2);
  assert.equal(bot.state.controls.forward, true);
  h.wanderer.tick();
  assert.equal(h.last('WANDER_LEG_START').leg, 2, 'a running leg is not restarted');
});

test('a pause between legs is respected when configured', () => {
  const bot = makeBot();
  const h = harness({ bot, pauseMs: 3000, random: () => 0 });
  h.wanderer.tick();
  bot.moveTo(2.0, 64, 0.5);
  h.wanderer.monitor();
  h.wanderer.tick();
  assert.equal(h.last('WANDER_LEG_START').leg, 1, 'still paused');
  h.clock.t += 3000;
  h.wanderer.tick();
  assert.equal(h.last('WANDER_LEG_START').leg, 2);
});

test('the bot jumps on every third leg and releases the jump key', () => {
  const values = [0.1, 0.6, 0.35, 0.8, 0.5, 0.2, 0.7, 0.45];
  let index = 0;
  const varying = () => values[index++ % values.length];
  const bot = makeBot();
  const h = harness({ bot, random: varying });
  for (let leg = 1; leg <= 3; leg++) {
    h.wanderer.tick();
    const start = h.last('WANDER_LEG_START');
    assert.equal(start.leg, leg);
    assert.equal(start.jump, leg === 3);
    if (leg < 3) {
      bot.moveTo(start.target.x, 64, start.target.z);
      h.wanderer.monitor();
      h.clock.t += 10;
    }
  }
  assert.equal(bot.state.controls.jump, false, 'jump key released by the previous leg');
  h.wanderer.monitor();
  assert.equal(bot.state.controls.jump, true);
  h.clock.t += 100;
  h.wanderer.monitor();
  assert.equal(bot.state.controls.jump, false);
  assert.equal(h.wanderer.getStats().jumps, 1);
});

test('being pushed out of the radius stops the leg but walking resumes', () => {
  const bot = makeBot();
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  bot.moveTo(9, 64, 0.5);
  h.wanderer.monitor();
  assert.equal(bot.state.controls.forward, false);
  assert.equal(h.last('WANDER_STOPPED').reason, 'out_of_range');
  assert.equal(h.wanderer.isDisabled(), false);
  bot.moveTo(1.0, 64, 0.5);
  h.wanderer.tick();
  assert.equal(bot.state.controls.forward, true);
});

test('every chosen target stays inside the radius and is far enough to walk to', () => {
  const anchor = { x: 10, y: 64, z: -3 };
  for (let i = 0; i < 200; i++) {
    assert.ok(distance2D(anchor, pickTarget(anchor, 5, null, Math.random)) <= 5);
    assert.ok(distance2D(anchor, pickTarget(anchor, 2, null, Math.random)) <= 2);
    const from = { x: 10 + Math.random() * 4 - 2, z: -3 + Math.random() * 4 - 2 };
    const target = pickTarget(anchor, 5, from, Math.random);
    assert.ok(distance2D(anchor, target) <= 5);
    assert.ok(distance2D(from, target) >= 1.5);
  }
  assert.ok(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 0, z: 1 })) < 0.01);
  assert.ok(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 1, z: 0 }) + Math.PI / 2) < 0.01);
});

test('walking does not start while the bot is airborne', () => {
  const bot = makeBot();
  bot.state.onGround = false;
  const h = harness({ bot });
  h.wanderer.tick();
  assert.equal(bot.state.controls.forward, undefined);
});

test('stats report legs, distance and stop reasons', () => {
  const bot = makeBot();
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  bot.moveTo(2.0, 64, 0.5);
  h.wanderer.monitor();
  h.wanderer.tick();
  bot.moveTo(9, 64, 0.5);
  h.wanderer.monitor();
  const stats = h.wanderer.getStats();
  assert.equal(stats.legs, 2);
  assert.ok(stats.movedBlocks > 0);
  assert.equal(stats.stops.out_of_range, 1);
});

test('an admin teleport re-anchors and re-reads the radius from the new block', () => {
  const bot = makeBot({ ground: (x, y, z) => (x === 0 && z === 0 ? 'gold_ore' : 'stone') });
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  h.wanderer.monitor();
  assert.equal(h.wanderer.getRadius(), 2);
  bot.moveTo(120.5, 64, 40.5);
  h.wanderer.monitor();
  assert.equal(h.last('WANDER_REANCHORED').jump, 126.49);
  assert.deepEqual(h.wanderer.getAnchor(), { x: 120.5, y: 64, z: 40.5 });
  assert.equal(h.wanderer.getRadius(), 5);
});

test('a pinned anchor is never moved by teleports and keeps the configured radius', () => {
  const bot = makeBot({ ground: 'gold_ore' });
  const h = harness({ bot, anchor: { x: 1, y: 50, z: -1 }, radius: 5, random: () => 0 });
  h.wanderer.tick();
  assert.equal(h.wanderer.getRadius(), 5, 'gold ore does not shrink an explicit radius');
  assert.deepEqual(h.wanderer.getAnchor(), { x: 1, y: 50, z: -1 });
  h.wanderer.monitor();
  bot.moveTo(120.5, 64, 40.5);
  h.wanderer.monitor();
  assert.equal(h.last('WANDER_TELEPORTED').jump, 126.49);
  assert.equal(h.last('WANDER_REANCHORED'), undefined);
  assert.deepEqual(h.wanderer.getAnchor(), { x: 1, y: 50, z: -1 });
});

test('outside the radius the bot walks back towards the anchor', () => {
  const bot = makeBot();
  const h = harness({ bot, anchor: { x: 0.5, y: 64, z: 0.5 }, radius: 5, random: () => 0 });
  bot.moveTo(30.5, 64, 0.5);
  h.wanderer.monitor();
  h.wanderer.tick();
  const start = h.last('WANDER_LEG_START');
  assert.equal(start.homing, true);
  assert.ok(start.target.x < 30.5, 'target is back towards the anchor');
  assert.ok(Math.abs(start.target.x - 27.5) < 0.01);
  // A homing leg is not killed by the normal radius guard.
  h.wanderer.monitor();
  assert.equal(h.last('WANDER_STOPPED'), undefined);
  assert.equal(bot.state.controls.forward, true);
});

test('homing gives up only when the anchor is absurdly far away', () => {
  const bot = makeBot();
  const h = harness({ bot, anchor: { x: 0.5, y: 64, z: 0.5 }, radius: 5, maxHomingBlocks: 100, random: () => 0 });
  bot.moveTo(500.5, 64, 0.5);
  h.wanderer.monitor();
  h.wanderer.tick();
  h.wanderer.monitor();
  assert.equal(h.last('WANDER_STOPPED').reason, 'too_far_to_return');
  assert.equal(bot.state.controls.forward, false);
});

test('homingTarget never overshoots the anchor', () => {
  const anchor = { x: 0.5, y: 64, z: 0.5 };
  for (const x of [10, 40, 3]) {
    const target = homingTarget(anchor, 5, { x, z: 0.5 });
    assert.ok(Math.abs(target.x - anchor.x) < Math.abs(x - anchor.x));
    assert.ok(Math.abs(target.x - anchor.x) >= 0);
  }
  assert.deepEqual(homingTarget(anchor, 5, { x: 0.5, z: 0.5 }), { x: 0.5, z: 0.5 });
});

test('a death stops walking until the bot is moved again', () => {
  const bot = makeBot();
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  h.wanderer.monitor();
  const legsBefore = h.events.filter(e => e.event === 'WANDER_LEG_START').length;
  h.wanderer.disable('death');
  assert.equal(h.wanderer.isDisabled(), true);
  h.wanderer.tick();
  assert.equal(h.events.filter(e => e.event === 'WANDER_LEG_START').length, legsBefore);
  bot.moveTo(300.5, 64, 300.5);
  h.wanderer.monitor();
  h.wanderer.tick();
  assert.equal(h.wanderer.isDisabled(), false);
  assert.equal(h.events.filter(e => e.event === 'WANDER_LEG_START').length, legsBefore + 1);
});

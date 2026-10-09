'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distance2D, radiusFor, pickTarget, yawTowards, isGoldOre, createWanderer } = require('../src/wander');

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
  const bot = options.bot || makeBot(options);
  const wanderer = createWanderer({
    getBot: () => bot,
    anchor: options.anchor ?? null,
    random: options.random || (() => 0),
    log: (event, data = {}) => events.push({ event, ...data }),
    now: () => options.now ?? 0
  });
  return { bot, wanderer, events, last: name => events.filter(e => e.event === name).pop() };
}

test('the radius is 2 over gold ore and 5 over any other block', () => {
  assert.equal(radiusFor(makeBot({ ground: 'gold_ore' }), { x: 0.5, y: 64, z: 0.5 }).radius, 2);
  assert.equal(radiusFor(makeBot({ ground: 'stone' }), { x: 0.5, y: 64, z: 0.5 }).radius, 5);
  assert.equal(radiusFor(makeBot({ ground: 'grass' }), { x: 0.5, y: 64, z: 0.5 }).radius, 5);
  assert.equal(isGoldOre({ name: 'gold_ore' }), true);
  assert.equal(isGoldOre({ name: 'nether_gold_ore' }), true);
  assert.equal(isGoldOre({ name: 'stone' }), false);
  assert.equal(isGoldOre(null), false);
});

test('walking starts without any terrain checks and uses the spawn block radius', () => {
  const bot = makeBot({ ground: 'gold_ore' });
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  assert.equal(h.wanderer.getRadius(), 2);
  assert.equal(h.last('WANDER_RADIUS').goldOre, true);
  assert.equal(h.last('WANDER_RADIUS').block, 'gold_ore');
  assert.equal(bot.state.controls.forward, true);
  assert.equal(h.last('WANDER_LEG_START').radius, 2);
});

test('over an ordinary block the radius is five', () => {
  const bot = makeBot({ ground: 'stone' });
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  assert.equal(h.wanderer.getRadius(), 5);
  assert.equal(h.last('WANDER_LEG_START').radius, 5);
});

test('a leg ends when the target is reached and releases movement', () => {
  const bot = makeBot();
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  assert.equal(bot.state.controls.forward, true);
  bot.moveTo(2.0, 64, 0.5);
  h.wanderer.monitor();
  assert.equal(bot.state.controls.forward, false);
  assert.ok(h.last('WANDER_LEG_END').moved > 0);
});

test('every chosen target stays inside the radius', () => {
  const anchor = { x: 10, y: 64, z: -3 };
  for (let i = 0; i < 200; i++) {
    assert.ok(distance2D(anchor, pickTarget(anchor, 5, Math.random)) <= 5);
    assert.ok(distance2D(anchor, pickTarget(anchor, 2, Math.random)) <= 2);
  }
  assert.ok(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 0, z: 1 })) < 0.01);
  assert.ok(Math.abs(yawTowards({ x: 0, z: 0 }, { x: 1, z: 0 }) + Math.PI / 2) < 0.01);
});

test('being pushed outside the radius stops the leg', () => {
  const bot = makeBot();
  const h = harness({ bot, random: () => 0 });
  h.wanderer.tick();
  bot.moveTo(9, 64, 0.5);
  h.wanderer.monitor();
  assert.equal(bot.state.controls.forward, false);
  assert.equal(h.last('WANDER_STOPPED').reason, 'out_of_range');
});

test('walking does not start while the bot is airborne', () => {
  const bot = makeBot();
  bot.state.onGround = false;
  const h = harness({ bot });
  h.wanderer.tick();
  assert.equal(bot.state.controls.forward, undefined);
});

test('an admin teleport re-anchors and re-reads the radius from the new block', () => {
  // Gold ore only at the origin; everywhere else is ordinary stone.
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
  h.wanderer.tick();
  assert.equal(h.last('WANDER_LEG_START').radius, 5);
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

test('a configured anchor is honoured and reset clears movement', () => {
  const bot = makeBot();
  const h = harness({ bot, anchor: { x: 4, y: 64, z: 4 }, random: () => 0 });
  h.wanderer.tick();
  assert.deepEqual(h.wanderer.getAnchor(), { x: 4, y: 64, z: 4 });
  assert.equal(bot.state.controls.forward, true);
  h.wanderer.reset();
  assert.equal(bot.state.controls.forward, false);
  assert.equal(h.wanderer.isMoving(), false);
});

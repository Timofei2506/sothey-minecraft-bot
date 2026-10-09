'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handoffPlan, targetRunTitle, validateGate, sourceRunning } = require('../src/handoff');
const { readConfig } = require('../src/helpers');

test('second Sothey session schedules luvhi exactly 20 minutes before its end', () => {
  const start = 1800000000000;
  const p = handoffPlan(start, 14400);
  assert.equal(p.startEpoch, start / 1000 + 13200);
  assert.equal(p.endEpoch - p.startEpoch, 1200);
  assert.equal(p.startEpoch - p.dispatchEpoch, 1200);
  assert.equal(p.dispatchEpoch - start / 1000, 12000);
});

test('first luvhi job fits under GitHub six-hour ceiling with warm-up', () => {
  const p = handoffPlan(1800000000000, 14400);
  assert.ok(p.startEpoch - p.dispatchEpoch + 14400 < 21600);
});

test('invalid timings, expired handoffs and malformed run IDs fail closed', () => {
  assert.throws(() => handoffPlan(0, 1200));
  assert.throws(() => targetRunTitle('123/../../other'));
  assert.throws(() => validateGate(10000, '123', 0));
  assert.throws(() => validateGate(10000, '123', 11200));
  assert.doesNotThrow(() => validateGate(10000, '123', 9000));
});

test('source must still be actively running its second bot session', () => {
  const jobs = [{ name: 'Sothey 2/2', status: 'in_progress', steps: [{ name: 'Stay connected and arrange handoff', status: 'in_progress' }] }];
  assert.equal(sourceRunning({ status: 'in_progress' }, jobs), true);
  assert.equal(sourceRunning({ status: 'queued' }, jobs), true);
  assert.equal(sourceRunning({ status: 'completed', conclusion: 'failure' }, jobs), false);
  assert.equal(sourceRunning({ status: 'in_progress' }, []), false);
});

test('idle activity is slow and can be disabled explicitly', () => {
  assert.equal(readConfig({ MC_PASSWORD: 'test-password' }).idleActivitySeconds, 45);
  assert.equal(readConfig({ MC_PASSWORD: 'test-password', BOT_IDLE_ACTIVITY_SECONDS: '0' }).idleActivitySeconds, 0);
  assert.throws(() => readConfig({ MC_PASSWORD: 'test-password', BOT_IDLE_ACTIVITY_SECONDS: '1' }));
});

test('bot1 bridge starts before a runner swap and stays independent of the next job', () => {
  const { bridgePlan, bridgeRunTitle } = require('../src/handoff');
  const plan = bridgePlan(1800000000000, 14400);
  assert.equal(plan.endEpoch - plan.startEpoch, 120);
  assert.equal(plan.startEpoch - plan.dispatchEpoch, 600);
  assert.equal(bridgeRunTitle('123'), 'bot1 · transition bridge from 123');
  assert.ok(600 + 1800 < 21600);
});

test('bridge gate accepts only the correct active first session', () => {
  const jobs = [{ name: 'Sothey 1/2', status: 'in_progress', steps: [{ name: 'Stay connected and arrange bridge', status: 'in_progress' }] }];
  assert.equal(sourceRunning({ status: 'in_progress' }, jobs, 'Sothey 1/2'), true);
  assert.equal(sourceRunning({ status: 'in_progress' }, jobs, 'luvhi 1/2'), false);
  assert.equal(sourceRunning({ status: 'in_progress' }, jobs, 'unrelated'), false);
  const recovery = [{ name: 'luvhi 1/3', status: 'in_progress', steps: [{ name: 'Connect luvhi', status: 'in_progress' }] }];
  assert.equal(sourceRunning({ status: 'in_progress' }, recovery, 'luvhi 1/3'), true);
  assert.equal(sourceRunning({ status: 'in_progress' }, recovery, 'luvhi 2/3'), false);
  assert.throws(() => validateGate(10000, '123', 10120, 120));
});

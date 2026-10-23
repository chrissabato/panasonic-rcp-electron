const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/main/camera/controlRegistry');
const { scaleToRange } = require('../src/main/camera/CameraClient');

test('coerceValue clamps knobs and rockers to their range', () => {
    assert.equal(registry.coerceValue('iris', 150), 100);
    assert.equal(registry.coerceValue('iris', -5), 0);
    assert.equal(registry.coerceValue('iris_level', -80), -50);
    assert.equal(registry.coerceValue('zoom', 0), 1);
    assert.equal(registry.coerceValue('iris', '42.9'), 42);
    assert.equal(registry.coerceValue('iris', 'abc'), 0);
});

test('coerceValue validates select options', () => {
    assert.equal(registry.coerceValue('awb_mode', '10'), 10);
    assert.throws(() => registry.coerceValue('awb_mode', 3), RangeError);
});

test('coerceValue handles toggles, buttons and unknown controls', () => {
    assert.equal(registry.coerceValue('tally', 1), true);
    assert.equal(registry.coerceValue('tally', 0), false);
    assert.equal(registry.coerceValue('trigger_awb', false), true);
    assert.throws(() => registry.coerceValue('gamma', 1), RangeError);
    assert.equal(registry.isValid('toString'), false);
});

test('momentary controls are zoom, focus and AWB trigger', () => {
    const momentary = Object.keys(registry.all()).filter(registry.isMomentary);
    assert.deepEqual(momentary.sort(), ['focus', 'trigger_awb', 'zoom']);
});

test('scaleToRange maps UI values linearly into the native range', () => {
    assert.equal(scaleToRange(0, 0, 100, 0, 20000), 0);
    assert.equal(scaleToRange(50, 0, 100, 0, 20000), 10000);
    assert.equal(scaleToRange(100, 0, 100, 0, 20000), 20000);
    assert.equal(scaleToRange(50, 0, 100, -10, 10), 0);
    assert.equal(scaleToRange(50, 1, 99, -49, 49), 0); // speed stop
    assert.equal(scaleToRange(-50, -50, 50, -50, 50), -50);
    assert.equal(scaleToRange(500, 0, 100, 0, 20000), 20000); // clamped first
});

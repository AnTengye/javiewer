'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTracker } = require('./load-tracker');

test('retry delay grows exponentially and is capped at 60 seconds', () => {
    const { retryDelay } = loadTracker();
    assert.deepEqual(
        Array.from([1, 2, 3, 4, 5, 6].map(retryDelay)),
        [5000, 10000, 20000, 40000, 60000, 60000]
    );
});

test('pending key normalizes a code and rejects an invalid code', () => {
    const { pendingTrackKey } = loadTracker();
    assert.equal(pendingTrackKey('abc-123'), 'jt_pending_track_ABC-123');
    assert.equal(pendingTrackKey(''), null);
    assert.equal(pendingTrackKey(null), null);
});

test('strategy logger is enabled by default and can be disabled', () => {
    const calls = [];
    const { createStrategyLogger } = loadTracker();
    createStrategyLogger(true, { log: (...args) => calls.push(args) }).log('message');
    createStrategyLogger(false, { log: (...args) => calls.push(args) }).log('hidden');
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /\[JavBus Tracker\]/);
});

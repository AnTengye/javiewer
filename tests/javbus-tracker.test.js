'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTracker } = require('./load-tracker');

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        get: (key, fallback = null) => values.has(key) ? values.get(key) : fallback,
        set: (key, value) => values.set(key, value),
        remove: (key) => values.delete(key),
        list: () => [...values.keys()],
        values
    };
}

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

test('outbox persists before sending and removes only after success', async () => {
    const { createTrackOutbox } = loadTracker();
    const storage = createStorage();
    let existedDuringRequest = false;
    const outbox = createTrackOutbox({
        storage,
        now: () => 1000,
        request: async (code) => {
            existedDuringRequest = storage.values.has('jt_pending_track_ABC-123');
            assert.equal(code, 'ABC-123');
        },
        schedule: () => {},
        cancel: () => {},
        logger: { log() {}, warn() {}, error() {} }
    });

    await outbox.enqueueAndSend('abc-123');
    assert.equal(existedDuringRequest, true);
    assert.equal(storage.values.has('jt_pending_track_ABC-123'), false);
});

test('outbox retains failures with retry metadata and deduplicates by code', async () => {
    const { createTrackOutbox } = loadTracker();
    const storage = createStorage();
    const outbox = createTrackOutbox({
        storage,
        now: () => 2000,
        request: async () => { throw new Error('offline'); },
        schedule: () => {},
        cancel: () => {},
        logger: { log() {}, warn() {}, error() {} }
    });

    await outbox.enqueueAndSend('abc-123');
    await outbox.enqueueAndSend('ABC-123');
    const saved = storage.values.get('jt_pending_track_ABC-123');
    assert.equal(storage.list().length, 1);
    assert.equal(saved.code, 'ABC-123');
    assert.equal(saved.attempts, 2);
    assert.equal(saved.nextRetryAt, 12000);
    assert.match(saved.lastError, /offline/);
});

test('startup retries valid due records, removes corrupt records, and logs historical success', async () => {
    const { createTrackOutbox } = loadTracker();
    const storage = createStorage({
        'jt_pending_track_ABC-123': {
            code: 'ABC-123',
            createdAt: 1,
            updatedAt: 1,
            attempts: 1,
            nextRetryAt: 0,
            lastError: 'offline'
        },
        'jt_pending_track_broken': { nope: true }
    });
    const logs = [];
    const warnings = [];
    const outbox = createTrackOutbox({
        storage,
        now: () => 3000,
        request: async () => {},
        schedule: () => {},
        cancel: () => {},
        logger: {
            log: (message) => logs.push(message),
            warn: (message) => warnings.push(message),
            error() {}
        }
    });

    await outbox.retryDue();
    assert.equal(storage.list().length, 0);
    assert.ok(logs.some((line) => line.includes('检测到上一次有上传失败数据，已成功重试: ABC-123')));
    assert.equal(warnings.length, 1);
});

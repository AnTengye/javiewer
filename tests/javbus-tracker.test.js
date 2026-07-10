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

function createScheduler() {
    const jobs = [];
    return {
        schedule(fn, delay) {
            const job = { fn, delay, cancelled: false };
            jobs.push(job);
            return job;
        },
        cancel(job) {
            if (job) job.cancelled = true;
        },
        async runLatest() {
            const job = [...jobs].reverse().find((candidate) => !candidate.cancelled);
            assert.ok(job, 'expected a scheduled job');
            job.cancelled = true;
            await job.fn();
        },
        active: () => jobs.filter((job) => !job.cancelled)
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

test('list refresh waits five seconds after the latest click and batches unique codes', async () => {
    const { createReadRefreshCoordinator } = loadTracker();
    const scheduler = createScheduler();
    const batches = [];
    const coordinator = createReadRefreshCoordinator({
        query: async (codes) => {
            batches.push(Array.from(codes));
            return codes.map((code) => ({ code, viewed: true }));
        },
        apply: () => {},
        schedule: scheduler.schedule,
        cancel: scheduler.cancel,
        logger: { log() {}, warn() {} }
    });

    coordinator.collect('abc-123');
    coordinator.collect('def-456');
    coordinator.collect('ABC-123');
    assert.equal(scheduler.active().length, 1);
    assert.equal(scheduler.active()[0].delay, 5000);
    await scheduler.runLatest();
    assert.deepEqual(batches, [['ABC-123', 'DEF-456']]);
});

test('partial responses remain queued while successful items are applied', async () => {
    const { createReadRefreshCoordinator } = loadTracker();
    const scheduler = createScheduler();
    const applied = [];
    let calls = 0;
    const coordinator = createReadRefreshCoordinator({
        query: async () => ++calls === 1
            ? [{ code: 'ABC-123', viewed: true }]
            : [{ code: 'DEF-456', viewed: true }],
        apply: (item) => applied.push(item.code),
        schedule: scheduler.schedule,
        cancel: scheduler.cancel,
        logger: { log() {}, warn() {} }
    });

    coordinator.collect('ABC-123');
    coordinator.collect('DEF-456');
    await scheduler.runLatest();
    assert.deepEqual(applied, ['ABC-123']);
    assert.deepEqual(Array.from(coordinator.pending()), ['DEF-456']);
    assert.equal(scheduler.active().at(-1).delay, 5000);
});

test('clicks collected during an in-flight refresh are kept for the next batch', async () => {
    const { createReadRefreshCoordinator } = loadTracker();
    const scheduler = createScheduler();
    let resolveQuery;
    const coordinator = createReadRefreshCoordinator({
        query: () => new Promise((resolve) => { resolveQuery = resolve; }),
        apply: () => {},
        schedule: scheduler.schedule,
        cancel: scheduler.cancel,
        logger: { log() {}, warn() {} }
    });

    coordinator.collect('ABC-123');
    const running = scheduler.runLatest();
    coordinator.collect('DEF-456');
    resolveQuery([{ code: 'ABC-123', viewed: true }]);
    await running;
    assert.deepEqual(Array.from(coordinator.pending()), ['DEF-456']);
});

test('error text is bounded and non-error values are supported', () => {
    const { errorMessage } = loadTracker();
    assert.equal(errorMessage('offline'), 'offline');
    assert.equal(errorMessage(new Error('x'.repeat(300))).length, 200);
});

test('batch status treats a malformed payload as an empty result', () => {
    const { batchItems } = loadTracker();
    assert.deepEqual(Array.from(batchItems(null)), []);
    assert.deepEqual(Array.from(batchItems({})), []);
    assert.deepEqual(Array.from(batchItems({ items: 'bad' })), []);
    assert.deepEqual(
        Array.from(batchItems({ items: [{ code: 'ABC-123' }] }), (item) => ({ ...item })),
        [{ code: 'ABC-123' }]
    );
});

test('preview image URLs are upgraded from DMM thumbnails to large images', () => {
    const { getLargePreviewImageUrl, resolveLargePreviewImageUrl } = loadTracker();

    assert.equal(
        getLargePreviewImageUrl('https://pics.dmm.co.jp/digital/video/ssis00123/ssis00123-1.jpg'),
        'https://pics.dmm.co.jp/digital/video/ssis00123/ssis00123jp-1.jpg'
    );
    assert.equal(
        getLargePreviewImageUrl('https://pics.dmm.co.jp/digital/video/ssis00123/ssis00123-1.jpg?foo=1'),
        'https://pics.dmm.co.jp/digital/video/ssis00123/ssis00123jp-1.jpg?foo=1'
    );
    assert.equal(
        getLargePreviewImageUrl('https://pics.dmm.co.jp/digital/video/ssis00123/ssis00123jp-1.jpg'),
        'https://pics.dmm.co.jp/digital/video/ssis00123/ssis00123jp-1.jpg'
    );
    assert.equal(
        getLargePreviewImageUrl('https://pics.dmm.co.jp/digital/video/ssis00123/ps.jpg'),
        'https://pics.dmm.co.jp/digital/video/ssis00123/pl.jpg'
    );
    assert.equal(
        getLargePreviewImageUrl('https://example.com/page.html'),
        'https://example.com/page.html'
    );
    assert.equal(
        resolveLargePreviewImageUrl(
            'https://www.javbus.com/pics/sample/83ie_1.jpg',
            'https://pics.dmm.co.jp/digital/video/ssis00001/ssis00001jp-1.jpg'
        ),
        'https://pics.dmm.co.jp/digital/video/ssis00001/ssis00001jp-1.jpg'
    );
    assert.equal(
        resolveLargePreviewImageUrl(
            'https://www.javbus.com/pics/sample/cd8j_1.jpg',
            'https://image.mgstage.com/images/jackson/390jac/235/cap_e_0_390jac-235.jpg'
        ),
        'https://image.mgstage.com/images/jackson/390jac/235/cap_e_0_390jac-235.jpg'
    );
});

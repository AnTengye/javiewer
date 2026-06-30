# Resilient Tracking and Read Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make view reporting durable across weak networks and page closes, then batch-refresh clicked list items after five seconds without new clicks.

**Architecture:** Keep the deployable artifact as the existing single userscript. Add small dependency-injected coordinators inside its tracking IIFE: a persistent per-code outbox for `/api/film/track`, and a debounced refresh coordinator for list clicks. Node's built-in test runner will load the real first IIFE in a VM test mode, so tests exercise production functions without running the unrelated legacy enhancement IIFE.

**Tech Stack:** Tampermonkey userscript APIs, browser DOM APIs, JavaScript promises/timers, Node.js `node:test`, `node:assert`, and `node:vm`.

---

## File structure

- Modify `javbus-tracker.user.js`: add configuration, controlled logging, retry helpers, persistent outbox, list refresh coordinator, and page wiring.
- Create `tests/load-tracker.js`: load only the tracker IIFE from the real userscript into a controlled VM and return its test exports.
- Create `tests/javbus-tracker.test.js`: cover helpers, outbox behavior, list batching, logging, and edge conditions with fake dependencies.
- No package manifest or third-party test dependency is needed; run tests with Node directly.

### Task 1: Establish a production-code test seam and strategy helpers

**Files:**
- Modify: `javbus-tracker.user.js:19-301`
- Create: `tests/load-tracker.js`
- Create: `tests/javbus-tracker.test.js`

- [ ] **Step 1: Create the VM loader and failing helper tests**

Create `tests/load-tracker.js` with a loader that extracts the first IIFE, enables test mode, and returns production exports:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTracker(overrides = {}) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'javbus-tracker.user.js'),
        'utf8'
    );
    const start = source.indexOf('// ==================== 影视追踪助手 ====================');
    const end = source.indexOf('// ==================== JAV老司机');
    if (start < 0 || end < 0) throw new Error('Tracker IIFE markers not found');

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        globalThis: null,
        __JAVBUS_TRACKER_TEST_MODE__: true,
        ...overrides
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source.slice(start, end), sandbox, {
        filename: 'javbus-tracker.user.js'
    });
    return sandbox.__JAVBUS_TRACKER_TEST_EXPORTS__;
}

module.exports = { loadTracker };
```

Create the first tests in `tests/javbus-tracker.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTracker } = require('./load-tracker');

test('retry delay grows exponentially and is capped at 60 seconds', () => {
    const { retryDelay } = loadTracker();
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(retryDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
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
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test tests/javbus-tracker.test.js`

Expected: FAIL because `__JAVBUS_TRACKER_TEST_EXPORTS__`, `retryDelay`, `pendingTrackKey`, and `createStrategyLogger` do not exist.

- [ ] **Step 3: Add configuration, helpers, and the test export seam**

Add the following fields to `CONFIG`:

```js
ENABLE_CONSOLE_LOG: true,
CLICK_REFRESH_DELAY: 5000,
RETRY_BASE_DELAY: 5000,
RETRY_MAX_DELAY: 60000,
PENDING_TRACK_PREFIX: 'jt_pending_track_'
```

Add these helpers after `CONFIG`:

```js
function normalizeCode(code) {
    if (typeof code !== 'string') return null;
    const normalized = code.trim().toUpperCase();
    return /^[A-Z]+-\d+$/.test(normalized) ? normalized : null;
}

function retryDelay(attempts) {
    const exponent = Math.max(0, Number(attempts || 1) - 1);
    return Math.min(CONFIG.RETRY_BASE_DELAY * (2 ** exponent), CONFIG.RETRY_MAX_DELAY);
}

function pendingTrackKey(code) {
    const normalized = normalizeCode(code);
    return normalized ? `${CONFIG.PENDING_TRACK_PREFIX}${normalized}` : null;
}

function createStrategyLogger(enabled, target = console) {
    const write = (method, message, ...args) => {
        if (!enabled) return;
        const output = typeof target[method] === 'function' ? target[method] : target.log;
        output.call(target, `[JavBus Tracker] ${message}`, ...args);
    };
    return {
        log: (message, ...args) => write('log', message, ...args),
        warn: (message, ...args) => write('warn', message, ...args),
        error: (message, ...args) => write('error', message, ...args)
    };
}

const strategyLog = createStrategyLogger(CONFIG.ENABLE_CONSOLE_LOG);
```

Before `init()` is called, expose the strategy functions and return in test mode:

```js
if (globalThis.__JAVBUS_TRACKER_TEST_MODE__) {
    globalThis.__JAVBUS_TRACKER_TEST_EXPORTS__ = {
        normalizeCode,
        retryDelay,
        pendingTrackKey,
        createStrategyLogger
    };
    return;
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `node --test tests/javbus-tracker.test.js`

Expected: 3 tests PASS with no warnings or errors.

- [ ] **Step 5: Commit the test seam and helpers**

```powershell
git add -- javbus-tracker.user.js tests/load-tracker.js tests/javbus-tracker.test.js
git commit -m "test: add tracking strategy test seam"
```

### Task 2: Implement the persistent tracking outbox

**Files:**
- Modify: `javbus-tracker.user.js:13-18,190-274,680-703`
- Modify: `tests/javbus-tracker.test.js`

- [ ] **Step 1: Write failing tests for persistence, recovery, retry, and corruption**

Append tests using an in-memory GM storage adapter:

```js
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
        'jt_pending_track_ABC-123': { code: 'ABC-123', createdAt: 1, attempts: 1, nextRetryAt: 0 },
        'jt_pending_track_broken': { nope: true }
    });
    const logs = [];
    const warnings = [];
    const outbox = createTrackOutbox({
        storage,
        now: () => 3000,
        request: async () => {},
        schedule: () => {},
        logger: { log: (message) => logs.push(message), warn: (message) => warnings.push(message), error() {} }
    });

    await outbox.retryDue();
    assert.equal(storage.list().length, 0);
    assert.ok(logs.some((line) => line.includes('检测到上一次有上传失败数据，已成功重试: ABC-123')));
    assert.equal(warnings.length, 1);
});
```

- [ ] **Step 2: Run the outbox tests and verify RED**

Run: `node --test --test-name-pattern="outbox|startup" tests/javbus-tracker.test.js`

Expected: FAIL because `createTrackOutbox` is not exported.

- [ ] **Step 3: Implement the outbox and Tampermonkey storage adapter**

Add `// @grant GM_listValues` and `// @grant GM_deleteValue` to the metadata. Add this adapter and coordinator:

```js
function createGMStorage() {
    return {
        get: (key, fallback = null) => GM_getValue(key, fallback),
        set: (key, value) => GM_setValue(key, value),
        remove: (key) => GM_deleteValue(key),
        list: () => GM_listValues()
    };
}

function errorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    return message.slice(0, 200);
}

function createTrackOutbox({ storage, request, now = Date.now, schedule = setTimeout, logger }) {
    let retryTimer = null;

    const listRecords = () => storage.list()
        .filter((key) => key.startsWith(CONFIG.PENDING_TRACK_PREFIX))
        .map((key) => ({ key, value: storage.get(key, null) }));

    const isValid = ({ key, value }) => value && pendingTrackKey(value.code) === key &&
        Number.isFinite(value.createdAt) && Number.isFinite(value.attempts) && Number.isFinite(value.nextRetryAt);

    const armNextRetry = () => {
        if (retryTimer) clearTimeout(retryTimer);
        const next = listRecords().filter(isValid).reduce(
            (minimum, item) => Math.min(minimum, item.value.nextRetryAt),
            Infinity
        );
        if (Number.isFinite(next)) retryTimer = schedule(() => retryDue(), Math.max(0, next - now()));
    };

    const sendRecord = async (record, historical) => {
        try {
            await request(record.code);
            storage.remove(pendingTrackKey(record.code));
            logger.log(historical
                ? `检测到上一次有上传失败数据，已成功重试: ${record.code}`
                : `已上报查看: ${record.code}`);
            return true;
        } catch (error) {
            const attempts = Number(record.attempts || 0) + 1;
            const delay = retryDelay(attempts);
            storage.set(pendingTrackKey(record.code), {
                ...record,
                updatedAt: now(),
                attempts,
                nextRetryAt: now() + delay,
                lastError: errorMessage(error)
            });
            logger.warn(`网络异常，已保存待补报记录，将在 ${delay / 1000} 秒后重试: ${record.code}`);
            return false;
        }
    };

    const retryDue = async () => {
        const records = listRecords();
        const valid = [];
        for (const item of records) {
            if (!isValid(item)) {
                storage.remove(item.key);
                logger.warn(`已清理损坏的待补报记录: ${item.key}`);
            } else if (item.value.nextRetryAt <= now()) {
                valid.push(item.value);
            }
        }
        if (valid.length > 0) logger.log(`检测到 ${valid.length} 条历史上传失败记录，开始重试`);
        await Promise.all(valid.map((record) => sendRecord(record, true)));
        armNextRetry();
    };

    const enqueueAndSend = async (code) => {
        const normalized = normalizeCode(code);
        if (!normalized) return false;
        const key = pendingTrackKey(normalized);
        const existing = storage.get(key, null);
        const record = existing && pendingTrackKey(existing.code) === key ? existing : {
            code: normalized,
            createdAt: now(),
            updatedAt: now(),
            attempts: 0,
            nextRetryAt: now(),
            lastError: ''
        };
        storage.set(key, record);
        const success = await sendRecord(record, false);
        armNextRetry();
        return success;
    };

    return { enqueueAndSend, retryDue };
}
```

Export `createTrackOutbox` in test mode. Instantiate one outbox in runtime, with `request: (code) => apiRequest('/api/film/track', { code })`. Replace `trackView` with `trackOutbox.enqueueAndSend`, clear the normal status cache only after it resolves `true`, and call `trackOutbox.retryDue()` once during `init()` without blocking page initialization.

- [ ] **Step 4: Run all tests and verify GREEN**

Run: `node --test tests/javbus-tracker.test.js`

Expected: all helper and outbox tests PASS.

- [ ] **Step 5: Commit the durable outbox**

```powershell
git add -- javbus-tracker.user.js tests/javbus-tracker.test.js
git commit -m "feat: persist and retry failed view reports"
```

### Task 3: Batch-refresh clicked list items after a quiet period

**Files:**
- Modify: `javbus-tracker.user.js:242-260,325-570,650-689`
- Modify: `tests/javbus-tracker.test.js`

- [ ] **Step 1: Write failing tests for debounce, partial responses, and clicks during refresh**

Append a manual scheduler and coordinator tests:

```js
function createScheduler() {
    let jobs = [];
    return {
        schedule(fn, delay) {
            const job = { fn, delay, cancelled: false };
            jobs.push(job);
            return job;
        },
        cancel(job) { if (job) job.cancelled = true; },
        async runLatest() {
            const job = [...jobs].reverse().find((candidate) => !candidate.cancelled);
            await job.fn();
        },
        active: () => jobs.filter((job) => !job.cancelled)
    };
}

test('list refresh waits five seconds after the latest unique click and batches codes', async () => {
    const { createReadRefreshCoordinator } = loadTracker();
    const scheduler = createScheduler();
    const batches = [];
    const coordinator = createReadRefreshCoordinator({
        query: async (codes) => { batches.push(codes); return codes.map((code) => ({ code, viewed: true })); },
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
        query: async () => ++calls === 1 ? [{ code: 'ABC-123', viewed: true }] : [{ code: 'DEF-456', viewed: true }],
        apply: (item) => applied.push(item.code),
        schedule: scheduler.schedule,
        cancel: scheduler.cancel,
        logger: { log() {}, warn() {} }
    });

    coordinator.collect('ABC-123');
    coordinator.collect('DEF-456');
    await scheduler.runLatest();
    assert.deepEqual(applied, ['ABC-123']);
    assert.deepEqual(coordinator.pending(), ['DEF-456']);
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
    assert.deepEqual(coordinator.pending(), ['DEF-456']);
});
```

- [ ] **Step 2: Run the coordinator tests and verify RED**

Run: `node --test --test-name-pattern="list refresh|partial responses|in-flight" tests/javbus-tracker.test.js`

Expected: FAIL because `createReadRefreshCoordinator` is not exported.

- [ ] **Step 3: Implement the refresh coordinator**

Add this pure coordinator near the outbox:

```js
function createReadRefreshCoordinator({ query, apply, schedule = setTimeout, cancel = clearTimeout, logger }) {
    const queued = new Set();
    let timer = null;
    let refreshing = false;
    let failures = 0;

    const arm = (delay = CONFIG.CLICK_REFRESH_DELAY) => {
        if (timer) cancel(timer);
        timer = schedule(flush, delay);
    };

    const flush = async () => {
        timer = null;
        if (refreshing || queued.size === 0) return;
        refreshing = true;
        const batch = [...queued];
        logger.log(`5 秒内无新增点击，批量刷新 ${batch.length} 条已读状态`);
        try {
            const results = await query(batch);
            const requested = new Set(batch);
            const returned = new Set();
            for (const item of Array.isArray(results) ? results : []) {
                const code = normalizeCode(item && item.code);
                if (!code || !requested.has(code)) continue;
                returned.add(code);
                queued.delete(code);
                apply({ ...item, code });
            }
            failures = returned.size === batch.length ? 0 : failures + 1;
        } catch (error) {
            failures += 1;
        } finally {
            refreshing = false;
            if (queued.size > 0) {
                const delay = retryDelay(failures);
                logger.warn(`列表状态刷新失败，将在 ${delay / 1000} 秒后重试 ${queued.size} 条记录`);
                arm(delay);
            }
        }
    };

    const collect = (code) => {
        const normalized = normalizeCode(code);
        if (!normalized) return;
        queued.add(normalized);
        arm();
    };

    return { collect, flush, pending: () => [...queued] };
}
```

Export it in test mode.

- [ ] **Step 4: Wire delegated list clicks to uncached batch refresh**

Create the runtime coordinator on list pages:

```js
function applyFreshListStatus(item) {
    setCache(item.code, item);
    const element = getMovieItems().get(item.code);
    if (element) {
        renderItemBadges(element, item);
        processedCodes.add(item.code);
    }
}

function setupListReadRefresh() {
    const coordinator = createReadRefreshCoordinator({
        query: batchQueryStatus,
        apply: applyFreshListStatus,
        logger: strategyLog
    });
    document.addEventListener('click', (event) => {
        const link = event.target.closest?.('a[href]');
        const item = link?.closest?.('.item, .movie-box, .photo-frame');
        if (!item) return;
        coordinator.collect(extractCode(item));
    }, true);
    return coordinator;
}
```

Call `setupListReadRefresh()` in the list-page branch of `init()`. Keep `batchQueryStatus` as the direct API path so this explicit refresh bypasses `getCache`; its successful items refresh the cache only after the response arrives.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `node --test tests/javbus-tracker.test.js`

Expected: all helper, outbox, and refresh tests PASS.

- [ ] **Step 6: Commit list click refresh behavior**

```powershell
git add -- javbus-tracker.user.js tests/javbus-tracker.test.js
git commit -m "feat: batch refresh read status after list clicks"
```

### Task 4: Harden API edges and verify the integrated userscript

**Files:**
- Modify: `javbus-tracker.user.js:1-280`
- Modify: `tests/javbus-tracker.test.js`

- [ ] **Step 1: Write failing tests for malformed results and bounded error text**

Append:

```js
test('error text is bounded and non-error values are supported', () => {
    const { errorMessage } = loadTracker();
    assert.equal(errorMessage('offline'), 'offline');
    assert.equal(errorMessage(new Error('x'.repeat(300))).length, 200);
});

test('batch status treats a malformed payload as an empty result', async () => {
    const { batchItems } = loadTracker();
    assert.deepEqual(batchItems(null), []);
    assert.deepEqual(batchItems({}), []);
    assert.deepEqual(batchItems({ items: 'bad' }), []);
    assert.deepEqual(batchItems({ items: [{ code: 'ABC-123' }] }), [{ code: 'ABC-123' }]);
});
```

- [ ] **Step 2: Run edge tests and verify RED**

Run: `node --test --test-name-pattern="error text|malformed payload" tests/javbus-tracker.test.js`

Expected: FAIL because `errorMessage` is not exported and `batchItems` does not exist.

- [ ] **Step 3: Add the response boundary and route existing query code through it**

Add and export:

```js
function batchItems(result) {
    return result && Array.isArray(result.items) ? result.items : [];
}
```

Change `batchQueryStatus` to return `batchItems(result)`. Route API logging through `strategyLog`, and remove unconditional strategy-related `console.log`, `console.warn`, and `console.error` calls so `ENABLE_CONSOLE_LOG: false` consistently silences this feature. Retain unrelated legacy-script logging unchanged.

- [ ] **Step 4: Bump the userscript version and run all automated checks**

Change the metadata version from `2.3.0` to `2.4.0`.

Run:

```powershell
node --check javbus-tracker.user.js
node --test tests/javbus-tracker.test.js
git diff --check
```

Expected:

- `node --check` exits 0.
- All tests PASS with no warnings or errors.
- `git diff --check` prints nothing and exits 0.

- [ ] **Step 5: Inspect the final diff against the approved design**

Run:

```powershell
git diff -- javbus-tracker.user.js tests/javbus-tracker.test.js
rg -n "ENABLE_CONSOLE_LOG|GM_listValues|GM_deleteValue|检测到上一次|5 秒内无新增点击" javbus-tracker.user.js
```

Expected: the diff contains only the approved durable outbox, five-second quiet-window refresh, controlled logs, grants, tests, and version bump. Every searched marker appears in the userscript.

- [ ] **Step 6: Commit integration hardening**

```powershell
git add -- javbus-tracker.user.js tests/javbus-tracker.test.js
git commit -m "chore: harden tracking edge handling"
```

### Task 5: Final verification

**Files:**
- Verify: `javbus-tracker.user.js`
- Verify: `tests/load-tracker.js`
- Verify: `tests/javbus-tracker.test.js`

- [ ] **Step 1: Run the final clean verification suite**

Run:

```powershell
node --check javbus-tracker.user.js
node --test tests/javbus-tracker.test.js
git diff --check HEAD~3 HEAD
git status --short
```

Expected: syntax check exits 0, every test passes, diff check is empty, and status contains no uncommitted implementation files.

- [ ] **Step 2: Review behavior-specific evidence**

Run:

```powershell
node --test --test-name-pattern="outbox|startup|list refresh|partial responses|in-flight|logger" tests/javbus-tracker.test.js
```

Expected: all selected resilience, recovery, batching, concurrency, and logging tests PASS.

- [ ] **Step 3: Record final commit range for handoff**

Run:

```powershell
git log --oneline --decorate -5
```

Expected: the design commit followed by the test seam, outbox, list refresh, and hardening commits are visible in order.

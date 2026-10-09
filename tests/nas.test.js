'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNasTracker } = require('./load-tracker');

const BASE_URL = 'https://nas.example/qb';
const MAGNET = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Movie%20Name&tr=udp%3A%2F%2Ftracker.example%3A80';

function createNasHarness(version, addResponse = { status: 200, responseText: 'Ok.' }) {
    const calls = [];
    const tracker = loadNasTracker({
        GM_getValue: (key, fallback) => key === 'nas_qbittorrent_url' ? BASE_URL : fallback,
        GM_xmlhttpRequest: (details) => {
            calls.push(details);
            if (details.url === `${BASE_URL}/api/v2/app/version`) {
                details.onload(typeof version === 'string' ? { status: 200, responseText: version } : version);
            } else if (details.url === `${BASE_URL}/api/v2/torrents/add`) {
                if (addResponse) details.onload(addResponse);
            } else {
                throw new Error(`Unexpected request: ${details.url}`);
            }
        }
    });
    return { ...tracker, calls };
}

test('one-click NAS submits the tag and metadata stop condition together for qBittorrent 4 and 5', async (t) => {
    for (const [version, startField] of [
        ['v4.5.0', 'paused'],
        ['v4.6.7.10', 'paused'],
        ['v5.0.4', 'stopped'],
        ['5.2.0beta1', 'stopped']
    ]) {
        await t.test(version, async () => {
            const harness = createNasHarness(version);
            assert.equal(await harness.addMagnetToNas(MAGNET), true);
            assert.equal(harness.calls.length, 2);
            assert.equal(harness.calls[0].method, 'GET');
            const added = harness.calls[1];
            assert.equal(added.method, 'POST');
            assert.equal(added.headers.Origin, 'https://nas.example');
            assert.equal(added.headers.Referer, `${BASE_URL}/`);
            assert.match(added.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
            const fields = new URLSearchParams(added.data);
            assert.equal(fields.get('urls'), MAGNET);
            assert.equal(fields.get('tags'), 'filter-small');
            assert.equal(fields.get('stopCondition'), 'MetadataReceived');
            assert.equal(fields.get(startField), 'false');
            assert.equal(fields.has(startField === 'paused' ? 'stopped' : 'paused'), false);
        });
    }
});

test('one-click NAS completes on the add acknowledgement without waiting for metadata', async () => {
    const harness = createNasHarness('v5.0.4', null);
    let completed = false;
    const adding = harness.addMagnetToNas(MAGNET).then((result) => {
        completed = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(harness.calls.length, 2);
    assert.equal(completed, false);
    harness.calls[1].onload({ status: 200, responseText: 'Ok.' });
    assert.equal(await adding, true);
    assert.equal(completed, true);
    assert.equal(harness.calls.length, 2);
});

test('unsupported or invalid qBittorrent versions never add a torrent', async (t) => {
    for (const version of ['v4.4.5', 'v3.3.0', 'v6.0.0', '', '<html>Login required</html>']) {
        await t.test(version || 'empty', async () => {
            const harness = createNasHarness(version);
            await assert.rejects(harness.addMagnetToNas(MAGNET), /4\.5\+|无效版本号/);
            assert.equal(harness.calls.length, 1);
        });
    }
});

test('version lookup authentication and API errors never add a torrent', async (t) => {
    for (const status of [401, 403, 404, 500]) {
        await t.test(String(status), async () => {
            const harness = createNasHarness({ status, responseText: 'error' });
            await assert.rejects(harness.addMagnetToNas(MAGNET), /拒绝访问|未找到|HTTP/);
            assert.equal(harness.calls.length, 1);
        });
    }
});

test('one-click NAS requires qBittorrent to acknowledge the add', async (t) => {
    for (const response of [
        { status: 200, responseText: 'Fails.' },
        { status: 200, responseText: '' },
        { status: 403, responseText: 'Forbidden' }
    ]) {
        await t.test(`${response.status} ${response.responseText || 'empty'}`, async () => {
            const harness = createNasHarness('v5.0.4', response);
            await assert.rejects(harness.addMagnetToNas(MAGNET), /添加失败|未确认|拒绝访问/);
            assert.equal(harness.calls.length, 2);
        });
    }
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSection(startMarker, endMarker, exportName, overrides) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'javbus-tracker.user.js'),
        'utf8'
    );
    const start = source.indexOf(startMarker);
    const end = endMarker ? source.indexOf(endMarker) : source.length;
    if (start < 0 || end <= start) throw new Error('Tracker IIFE markers not found');

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        URL,
        URLSearchParams,
        globalThis: null,
        __JAVBUS_TRACKER_TEST_MODE__: true,
        ...overrides
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source.slice(start, end), sandbox, {
        filename: 'javbus-tracker.user.js'
    });
    return sandbox[exportName];
}

function loadTracker(overrides = {}) {
    return loadSection(
        '// ==================== 影视追踪助手 ====================',
        '// ==================== JAV老司机',
        '__JAVBUS_TRACKER_TEST_EXPORTS__',
        overrides
    );
}

function loadNasTracker(overrides = {}) {
    return loadSection(
        '// ==================== JAV老司机',
        null,
        '__JAVBUS_TRACKER_NAS_TEST_EXPORTS__',
        overrides
    );
}

module.exports = { loadTracker, loadNasTracker };

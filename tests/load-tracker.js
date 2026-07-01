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

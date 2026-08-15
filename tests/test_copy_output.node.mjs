// Node tests for the mobile copy workaround:
//   client/js/output-scan.js      — finding urls / codes in pane output
//   client/js/clipboard-compat.js — the clipboard tier ladder
//
// WHY THESE MATTER: `navigator.clipboard` is gated on a secure context.
// This app is served over plain http on a Tailscale hostname, so the API
// is not merely permission-denied, it is UNDEFINED — measured in a real
// browser on 2026-08-15 (http://<lan-ip>:5001 -> isSecureContext false,
// navigator.clipboard undefined). Testing on 127.0.0.1 hides this
// completely because localhost is exempt from the secure-context rule,
// which is exactly how the dead end survived. The absent-API case below
// is therefore the load-bearing assertion.
//
// Run with: node tests/test_copy_output.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(file) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', 'js', file), 'utf8');
}

const scanSrc = read('output-scan.js');
const compatSrc = read('clipboard-compat.js');

let failures = 0;
let passes = 0;

async function test(name, fn) {
    try {
        await fn();
        passes++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

function loadScan() {
    const sandbox = { window: {}, console: { warn() {} } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(scanSrc, sandbox);
    return sandbox.window.OutputScan;
}

/**
 * Load clipboard-compat with a controllable environment.
 *
 * @param {object} opts
 * @param {boolean} opts.asyncClipboard - expose navigator.clipboard.
 * @param {boolean} opts.asyncRejects   - make writeText reject.
 * @param {boolean} opts.execWorks      - execCommand('copy') return value.
 */
function loadCompat(opts) {
    const calls = { writeText: [], exec: [] };
    const navigator = {};
    if (opts.asyncClipboard) {
        navigator.clipboard = {
            writeText(text) {
                calls.writeText.push(text);
                return opts.asyncRejects
                    ? Promise.reject(new Error('denied'))
                    : Promise.resolve();
            },
        };
    }

    const makeEl = () => ({
        style: {},
        value: '',
        readOnly: false,
        contentEditable: 'false',
        setAttribute() {},
        setSelectionRange() {},
        remove() {},
    });

    const document = {
        body: { appendChild() {} },
        createElement: makeEl,
        createRange: () => ({ selectNodeContents() {} }),
        execCommand(cmd) {
            calls.exec.push(cmd);
            return !!opts.execWorks;
        },
    };

    const sandbox = {
        window: {
            getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        },
        navigator,
        document,
        console: { warn() {} },
        Promise,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(compatSrc, sandbox);
    return { api: sandbox.window.CopyCompat, calls };
}

/* ===================================================================
 * output-scan
 * =================================================================== */

// The shape claude prints for /login: a long url on one line and a
// short code on another. Neither is selectable on a phone.
const LOGIN_OUTPUT = [
    'Browser didn\'t open? Use the url below to sign in:',
    '',
    'https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=user',
    '',
    'Then enter this code: WDJB-MJHT',
    '',
].join('\n');

await test('finds the sign-in url in login output', () => {
    const scan = loadScan();
    const urls = scan.findUrls(LOGIN_OUTPUT);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith('https://claude.ai/oauth/authorize'));
});

await test('finds the sign-in code in login output', () => {
    const scan = loadScan();
    assert.ok(loadScan().findCodes(LOGIN_OUTPUT).includes('WDJB-MJHT'));
});

await test('scan surfaces both, urls before codes', () => {
    const items = loadScan().scan(LOGIN_OUTPUT);
    assert.equal(items[0].kind, 'url');
    assert.ok(items.some((i) => i.kind === 'code' && i.value === 'WDJB-MJHT'));
});

await test('trailing sentence punctuation is trimmed off a url', () => {
    const urls = loadScan().findUrls('see https://example.com/a/b.');
    assert.equal(urls[0], 'https://example.com/a/b');
});

await test('the most recent url comes first', () => {
    const urls = loadScan().findUrls('https://old.example.com/x\nhttps://new.example.com/y');
    assert.equal(urls[0], 'https://new.example.com/y');
});

await test('duplicate urls collapse to one entry', () => {
    const text = 'https://example.com/same\nhttps://example.com/same';
    assert.equal(loadScan().findUrls(text).length, 1);
});

await test('shouty prose words are not mistaken for codes', () => {
    // No digit and no dash, so ERROR/WARNING/README must not qualify —
    // otherwise every stack trace fills the sheet with noise.
    const codes = loadScan().findCodes('ERROR WARNING READMEFILE');
    assert.equal(codes.length, 0, `unexpected codes: ${codes.join(',')}`);
});

await test('url fragments are not re-offered as codes', () => {
    const codes = loadScan().findCodes('https://claude.ai/oauth?client_id=ABC123456');
    assert.ok(!codes.includes('ABC123456'));
});

await test('scan is empty and does not throw on empty output', () => {
    assert.equal(loadScan().scan('').length, 0);
    assert.equal(loadScan().scan(null).length, 0);
});

await test('scan respects its limit', () => {
    let text = '';
    for (let i = 0; i < 40; i++) text += `https://example.com/path${i}\n`;
    assert.equal(loadScan().scan(text, 5).length, 5);
});

/* ===================================================================
 * clipboard-compat
 * =================================================================== */

await test('secure context uses the async clipboard', async () => {
    const { api, calls } = loadCompat({ asyncClipboard: true });
    const result = await api.copyText('hello');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'async');
    assert.equal(calls.writeText.join(','), 'hello');
    assert.equal(calls.exec.length, 0, 'must not also run execCommand');
});

await test('THE BUG: no clipboard API at all still copies via execCommand', async () => {
    // Plain http on Tailscale. Previously this path reported "clipboard
    // unavailable on this connection" and copied nothing.
    const { api, calls } = loadCompat({ asyncClipboard: false, execWorks: true });
    assert.equal(api.hasAsyncClipboard(), false);
    const result = await api.copyText('WDJB-MJHT');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'exec');
    assert.equal(calls.exec.join(','), 'copy');
});

await test('async present but refused falls back to execCommand', async () => {
    const { api, calls } = loadCompat({
        asyncClipboard: true, asyncRejects: true, execWorks: true,
    });
    const result = await api.copyText('x');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'exec');
    assert.equal(calls.exec.join(','), 'copy');
});

await test('both tiers refused reports manual, never a false success', async () => {
    const { api } = loadCompat({ asyncClipboard: false, execWorks: false });
    const result = await api.copyText('x');
    assert.equal(result.ok, false);
    assert.equal(result.method, 'manual');
});

await test('empty text is a no-op, not a copy', async () => {
    const { api, calls } = loadCompat({ asyncClipboard: true });
    const result = await api.copyText('');
    assert.equal(result.ok, false);
    assert.equal(result.method, 'manual');
    assert.equal(calls.writeText.length, 0);
});

await test('copyText never rejects', async () => {
    const { api } = loadCompat({ asyncClipboard: true, asyncRejects: true, execWorks: false });
    const result = await api.copyText('x');
    assert.equal(result.ok, false);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
    console.error('FAILURES');
    process.exit(1);
}
console.log('ALL PASS');

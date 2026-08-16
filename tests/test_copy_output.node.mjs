// Node tests for the mobile copy workaround:
//   client/js/output-scan.js      — finding urls / codes in pane output
//   client/js/clipboard-compat.js — the clipboard tier ladder
//   client/js/copy-output.js      — buffer reading and chip labelling
//
// 2026-08-16: these tests all passed while the feature was completely
// broken in a browser, which is the reason for two of the sections below.
// A simulated execCommand cannot reproduce "returned true, copied an
// empty selection", so the ladder is now asserted on the COPY EVENT it
// raises rather than on execCommand's return value, and a false-success
// case is asserted explicitly. The end-to-end proof lives in
// tests/manual/verify_copy_output.py, which drives real Chromium.
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
const outputSrc = read('copy-output.js');

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
 * The fake DOM models the parts that actually decide the outcome: real
 * text nodes (so a Range over them has content), focus, and a copy event
 * that only fires when there is something selected. `suppressCopyEvent`
 * reproduces the measured shipped failure — execCommand answering true
 * while no copy event is raised at all.
 *
 * @param {object} opts
 * @param {boolean} opts.asyncClipboard    - expose navigator.clipboard.
 * @param {boolean} opts.asyncRejects      - make writeText reject.
 * @param {boolean} opts.execWorks         - execCommand('copy') return value.
 * @param {boolean} opts.suppressCopyEvent - return true but raise no event.
 * @param {boolean} opts.noClipboardData   - event without clipboardData.
 * @returns {{api: object, calls: object}}
 */
function loadCompat(opts) {
    const calls = { writeText: [], exec: [], setData: [], focused: [] };
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
        children: [],
        setAttribute() {},
        appendChild(node) { this.children.push(node); },
        focus() { calls.focused.push(this); },
        remove() {},
        text() { return this.children.map((c) => c.nodeValue || '').join(''); },
    });

    // A Range holds text; the SELECTION only holds it once the range is
    // added. Modelling that separately matters, because the real code
    // clears the selection between building the range and adding it.
    let ranged = '';
    let selected = '';
    const listeners = [];

    const document = {
        body: { appendChild() {} },
        createElement: makeEl,
        createTextNode: (value) => ({ nodeValue: value }),
        createRange: () => ({
            selectNodeContents(el) { ranged = el.text ? el.text() : ''; },
        }),
        addEventListener(type, fn) { listeners.push({ type, fn }); },
        removeEventListener(type, fn) {
            const i = listeners.findIndex((l) => l.fn === fn);
            if (i >= 0) listeners.splice(i, 1);
        },
        execCommand(cmd) {
            calls.exec.push(cmd);
            if (!opts.execWorks) return false;
            if (opts.suppressCopyEvent) return true;
            // A browser only raises a copy event when something is
            // selected. That is the whole point of the fix.
            if (!selected) return true;
            const event = {
                clipboardData: opts.noClipboardData ? null : {
                    setData(type, value) { calls.setData.push(value); },
                },
                preventDefault() {},
            };
            listeners
                .filter((l) => l.type === 'copy')
                .forEach((l) => l.fn(event));
            return true;
        },
    };

    const sandbox = {
        window: {
            getSelection: () => ({
                removeAllRanges() { selected = ''; },
                addRange() { selected = ranged; },
                toString() { return selected; },
            }),
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

/**
 * Load copy-output.js far enough to reach its pure helpers. It only needs
 * a window to hang its namespace on; nothing here builds DOM.
 *
 * @returns {object} the CopyOutput namespace.
 */
function loadOutput() {
    const sandbox = {
        window: {},
        document: { createElement: () => ({ style: {}, dataset: {} }) },
        console: { warn() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(outputSrc, sandbox);
    return sandbox.window.CopyOutput;
}

/**
 * Build a fake xterm buffer from rows, `|` marking a wrapped continuation.
 *
 * @param {string[]} rows - each entry is a VISUAL row, as xterm stores it.
 * @returns {object} something shaped like a Terminal.
 */
function fakeTerm(rows) {
    return {
        buffer: {
            active: {
                length: rows.length,
                getLine(i) {
                    const row = rows[i];
                    if (row === undefined) return null;
                    return {
                        isWrapped: row.startsWith('|'),
                        translateToString: () => row.replace(/^\|/, ''),
                    };
                },
            },
        },
    };
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

await test('the exec tier focuses and selects real text before copying', async () => {
    // The shipped bug: nothing was focused and the Range covered a
    // textarea with no child nodes, so the selection was empty. Measured
    // in Chromium 2026-08-16 — the copy event fired with
    // getSelection().toString() === '' and activeElement still the chip.
    const { api, calls } = loadCompat({ asyncClipboard: false, execWorks: true });
    const result = await api.copyText('https://claude.ai/oauth/authorize?x=1');
    assert.equal(result.ok, true);
    assert.equal(calls.focused.length, 1, 'copy source must take focus');
    assert.equal(calls.setData.join(','), 'https://claude.ai/oauth/authorize?x=1');
});

await test('THE FALSE SUCCESS: execCommand true with no copy event is a failure', async () => {
    // Worse than a dead tap: the user is told it worked and pastes
    // nothing. Success is now conditional on the event actually firing.
    const { api } = loadCompat({
        asyncClipboard: false, execWorks: true, suppressCopyEvent: true,
    });
    const result = await api.copyText('WDJB-MJHT');
    assert.equal(result.ok, false);
    assert.equal(result.method, 'manual');
});

await test('a copy event without clipboardData still counts, the selection IS the text', async () => {
    const { api, calls } = loadCompat({
        asyncClipboard: false, execWorks: true, noClipboardData: true,
    });
    const result = await api.copyText('WDJB-MJHT');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'exec');
    assert.equal(calls.setData.length, 0);
});

await test('newlines survive the exec tier, so copy all is not one long line', async () => {
    const { api, calls } = loadCompat({ asyncClipboard: false, execWorks: true });
    await api.copyText('line one\nline two');
    assert.equal(calls.setData.join(''), 'line one\nline two');
});

/* ===================================================================
 * copy-output: buffer reading and chip labels
 * =================================================================== */

const WRAPPED_URL =
    'https://claude.ai/oauth/authorize?code=true&client_id=9d1c3f7a&scope=user';

await test('THE PHONE BUG: a display-wrapped url is rejoined, not cut', () => {
    // A narrow pane stores one buffer row per VISUAL row. Joining them
    // all with a newline truncated the sign-in url at the pane width,
    // which is why the phone showed a stub and the wide desktop pane did
    // not. Genuinely short token, not a display truncation.
    const rows = [
        'Use the url below to sign in:',
        'https://claude.ai/oauth/autho',
        '|rize?code=true&client_id=9d1c',
        '|3f7a&scope=user',
    ];
    const text = loadOutput().readRecentOutput(fakeTerm(rows));
    assert.ok(
        text.includes(WRAPPED_URL),
        `url was cut: ${JSON.stringify(text)}`
    );
    assert.equal(text.split('\n').length, 2);
});

await test('an unwrapped line break is still a line break', () => {
    const text = loadOutput().readRecentOutput(fakeTerm(['alpha', 'beta']));
    assert.equal(text, 'alpha\nbeta');
});

await test('a continuation row is not right-trimmed mid-token', () => {
    // Trimming a continuation would eat characters that belong to the
    // token; only the row that ENDS a logical line may be trimmed.
    const text = loadOutput().readRecentOutput(fakeTerm(['ab   ', '|  cd   ']));
    assert.equal(text, 'ab     cd');
});

await test('a window starting mid-wrap does not lose its first row', () => {
    // The head of that logical line scrolled out of the buffer window.
    const text = loadOutput().readRecentOutput(fakeTerm(['|tail-of-a-url', 'next']));
    assert.equal(text, 'tail-of-a-url\nnext');
});

await test('a short chip label is left exactly as it is', () => {
    assert.equal(loadOutput().shortenForChip('WDJB-MJHT'), 'WDJB-MJHT');
});

await test('THE LABEL IS NOT THE VALUE: shortening never changes what is copied', () => {
    const out = loadOutput();
    const label = out.shortenForChip(WRAPPED_URL);
    assert.ok(label.length < WRAPPED_URL.length, 'label must be shortened');
    assert.ok(label.includes('...'), 'the cut must be visible');
    // Both ends survive, so the user can recognise it, and the value the
    // chip copies is untouched by any of this.
    assert.ok(WRAPPED_URL.startsWith(label.split('...')[0]));
    assert.ok(WRAPPED_URL.endsWith(label.split('...')[1]));
});

await test('shortening is a display concern only and never mutates input', () => {
    const out = loadOutput();
    const value = WRAPPED_URL;
    out.shortenForChip(value, 20);
    assert.equal(value, WRAPPED_URL);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
    console.error('FAILURES');
    process.exit(1);
}
console.log('ALL PASS');

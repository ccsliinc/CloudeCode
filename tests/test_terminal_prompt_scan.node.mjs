// Node test for client/js/terminal-prompt-scan.js - the rule that decides
// which rows of the xterm buffer are prompts the USER typed.
//
// WHY THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE. A detector that
// says yes to everything satisfies every positive assertion here
// perfectly and produces a rail with a tick beside every line of output,
// which is worse than no rail: the user learns the control is noise and
// stops using it. So every shape that LOOKS like a prompt and is not gets
// its own case - claude's own assistant bullet, a markdown quote, a bare
// caret with no palette background, and the live input box the user is
// typing into right now.
//
// The buffer is hand-built rather than driven through a real xterm: the
// module is pure by design, the cell API it uses is four methods, and a
// fake is the only way to assert the SHARED-CELL contract, which is about
// allocation and is invisible from outside.
//
// Run with: node tests/test_terminal_prompt_scan.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(__dirname, '..', 'client', 'js');

let failures = 0;
let passes = 0;

function test(name, fn) {
    try {
        fn();
        passes++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

/**
 * Description: load the scanner alone into a bare realm.
 * Inputs: none.
 * Output: object - window.TerminalPromptScan.
 */
function loadModule() {
    const sandbox = { console: { log() {}, warn() {}, error() {} } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(CLIENT_JS, 'terminal-prompt-scan.js'), 'utf8'),
        sandbox, { filename: 'terminal-prompt-scan.js' });
    return sandbox.window.TerminalPromptScan;
}

/**
 * Description: copy a value out of the vm realm into this one.
 *   `assert/strict`'s deepEqual compares PROTOTYPES, and an array built
 *   inside `vm.createContext` has that context's Array.prototype, so a
 *   correct answer fails with "same structure but not reference-equal".
 * Inputs: v (any) - a JSON-shaped value from the sandbox.
 * Output: the same value with this realm's prototypes.
 */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const CARET = '❯';
const NBSP = ' ';

/**
 * Description: build a fake buffer from a row spec.
 * Inputs: rows (Array<{text, kind}>) - kind is 'plain', 'prompt' or
 *   'cont'. opts (object) - {baseY, viewportY, type}.
 * Output: object - the buffer, plus `stats` recording how the module
 *   read it (`nullCells`, `cellArgs`) so the shared-cell contract can be
 *   asserted.
 */
function makeBuf(rows, opts = {}) {
    const stats = { nullCells: 0, cellArgs: [] };
    const shared = {};
    const specFor = (row) => {
        if (row.kind === 'prompt') {
            return { chars: CARET, palette: true, bg: 237, fg: 239 };
        }
        if (row.kind === 'cont') {
            return { chars: (row.text || ' ').charAt(0) || ' ',
                     palette: true, bg: 237, fg: 250 };
        }
        return { chars: (row.text || ' ').charAt(0) || ' ',
                 palette: false, bg: -1, fg: -1 };
    };
    const buf = {
        length: rows.length,
        baseY: opts.baseY === undefined ? 0 : opts.baseY,
        viewportY: opts.viewportY === undefined ? 0 : opts.viewportY,
        type: opts.type || 'normal',
        getNullCell() { stats.nullCells++; return shared; },
        getLine(i) {
            const row = rows[i];
            if (!row) return undefined;
            const spec = specFor(row);
            return {
                isWrapped: !!row.wrapped,
                translateToString(trim) {
                    return trim ? String(row.text).replace(/\s+$/, '') : String(row.text);
                },
                getCell(x, out) {
                    stats.cellArgs.push(out);
                    const target = out || {};
                    target.getChars = () => spec.chars;
                    target.isBgPalette = () => spec.palette;
                    target.getBgColor = () => spec.bg;
                    target.getFgColor = () => spec.fg;
                    return target;
                },
            };
        },
    };
    buf.stats = stats;
    return buf;
}

const promptRow = (text) => ({ kind: 'prompt', text: CARET + NBSP + text });
const contRow = (text) => ({ kind: 'cont', text });
const plainRow = (text) => ({ kind: 'plain', text });

const Scan = loadModule();

test('a caret over palette 237/239 is a prompt, and its text is the row', () => {
    const buf = makeBuf([plainRow('some output'), promptRow('run the tests')]);
    const got = Scan.scan(buf, { cols: 80 });
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'run the tests');
    assert.equal(got[0].line, 1);
    assert.equal(got[0].ordinal, 1);
});

test('NEGATIVE CONTROL: an assistant bullet row is never a prompt', () => {
    const buf = makeBuf([plainRow('⏺ Bash(ls -la)'), plainRow('  total 8')]);
    assert.equal(Scan.scan(buf, { cols: 80 }).length, 0);
});

test('NEGATIVE CONTROL: a markdown quote row is never a prompt', () => {
    const buf = makeBuf([plainRow('> quoted text from a document')]);
    assert.equal(Scan.scan(buf, { cols: 80 }).length, 0);
});

test('NEGATIVE CONTROL: a caret with no palette background is not a prompt', () => {
    // claude prints this glyph in other chrome. The colours are the
    // detector, and a text rule would claim every one of them.
    const buf = makeBuf([{ kind: 'plain', text: CARET + ' not a prompt' }]);
    assert.equal(Scan.scan(buf, { cols: 80 }).length, 0);
});

test('NEGATIVE CONTROL: the right glyph on the WRONG palette pair is not a prompt', () => {
    assert.equal(Scan.isPromptCell({
        getChars: () => CARET, isBgPalette: () => true,
        getBgColor: () => 236, getFgColor: () => 239,
    }), false);
    assert.equal(Scan.isPromptCell({
        getChars: () => CARET, isBgPalette: () => true,
        getBgColor: () => 237, getFgColor: () => 250,
    }), false);
    assert.equal(Scan.isPromptCell({
        getChars: () => CARET, isBgPalette: () => false,
        getBgColor: () => 237, getFgColor: () => 239,
    }), false);
});

test('continuation rows fold into the prompt above them', () => {
    const buf = makeBuf([
        promptRow('please run'),
        contRow('the whole suite'),
        plainRow('output follows'),
    ]);
    const got = Scan.scan(buf, { cols: 80 });
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'please run the whole suite');
});

test('a row cut by the pane width folds with NO space, as copy-output does', () => {
    // cols is 11 and the first row fills it exactly, so the split is
    // mid-token and joining with a space would break the path in half.
    const buf = makeBuf([
        { kind: 'prompt', text: CARET + NBSP + '/Users/a/lo' },
        contRow('ng/path.txt'),
    ], {});
    const got = Scan.scan(buf, { cols: 11 });
    assert.equal(got[0].text, '/Users/a/long/path.txt');
});

test('a prompt in claude bash mode is skipped', () => {
    const buf = makeBuf([promptRow('!ls -la'), promptRow('real prompt')]);
    const got = Scan.scan(buf, { cols: 80 });
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'real prompt');
});

test('an empty prompt row produces no tick', () => {
    const buf = makeBuf([promptRow(''), promptRow('   ')]);
    assert.equal(Scan.scan(buf, { cols: 80 }).length, 0);
});

test('a repaint that draws the same prompt twice counts once', () => {
    const buf = makeBuf([
        promptRow('deploy it'),
        plainRow(''),
        promptRow('deploy it'),
        plainRow(''),
        promptRow('now revert'),
    ]);
    const got = Scan.scan(buf, { cols: 80 });
    assert.deepEqual(plain(got.map(p => p.text)), ['deploy it', 'now revert']);
    assert.deepEqual(plain(got.map(p => p.ordinal)), [1, 2]);
});

test('the live input box is excluded, and only in the live region', () => {
    const isRule = (row) => /─{20,}/.test(row);
    const rule = '─'.repeat(40);
    // Row 1 is a submitted prompt with a rule beside it up in the
    // scrollback; row 6 is the live box. Only row 6 may be dropped.
    const rows = [
        plainRow(rule),
        promptRow('an old prompt'),
        plainRow('output'),
        plainRow('more output'),
        plainRow(rule),
        promptRow('what I am typing now'),
    ];
    rows.push(plainRow(rule));
    const buf = makeBuf(rows, { baseY: 4, viewportY: 4 });
    const got = Scan.scan(buf, { cols: 80, baseY: 4, rows: 3, isRule });
    assert.deepEqual(plain(got.map(p => p.text)), ['an old prompt']);
});

test('with no isRule injected nothing is excluded, rather than everything', () => {
    const rule = '─'.repeat(40);
    const buf = makeBuf([plainRow(rule), promptRow('typing'), plainRow(rule)],
        { baseY: 0 });
    const got = Scan.scan(buf, { cols: 80, baseY: 0, rows: 3 });
    assert.equal(got.length, 1);
});

test('the preview is the first 80 characters and the text is capped at 2000', () => {
    const long = 'x'.repeat(3000);
    const buf = makeBuf([promptRow(long)]);
    const got = Scan.scan(buf, { cols: 0 });
    assert.equal(got[0].preview.length, Scan.PREVIEW_CHARS);
    assert.equal(got[0].preview.length, 80);
    assert.equal(got[0].text.length, Scan.MAX_TEXT);
});

test('ONE cell object is allocated for the whole scan and reused every row', () => {
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push(plainRow('line ' + i));
    rows.push(promptRow('a prompt'));
    const buf = makeBuf(rows);
    Scan.scan(buf, { cols: 80 });
    assert.equal(buf.stats.nullCells, 1,
        'getNullCell must be called exactly once per scan');
    assert.ok(buf.stats.cellArgs.length >= 51, 'every row is read');
    const first = buf.stats.cellArgs[0];
    assert.ok(first, 'the shared cell must be passed to getCell');
    for (const arg of buf.stats.cellArgs) {
        assert.equal(arg, first, 'every getCell must receive the SAME cell');
    }
});

test('an unreadable buffer answers with no prompts rather than throwing', () => {
    assert.equal(Scan.scan(null, {}).length, 0);
    assert.equal(Scan.scan({ length: 3, getLine() { throw new Error('x'); } },
        { cols: 80 }).length, 0);
});

// ---- the rail's pure geometry, which lives in this module ----

test('ticks are proportional to the buffer, not to the prompt index', () => {
    const ticks = Scan.layoutTicks(
        [{ ordinal: 1, line: 0 }, { ordinal: 2, line: 50 }, { ordinal: 3, line: 100 }],
        100, 200);
    assert.deepEqual(plain(ticks.map(t => t.y)), [0, 100, 200]);
    assert.deepEqual(plain(ticks.map(t => t.ordinals)), [[1], [2], [3]]);
});

test('two prompts on adjacent rows are nudged to the minimum gap', () => {
    const ticks = Scan.layoutTicks(
        [{ ordinal: 1, line: 0 }, { ordinal: 2, line: 1 }], 1000, 400);
    assert.equal(ticks[0].y, 0);
    assert.ok(ticks[1].y - ticks[0].y >= Scan.TICK_MIN_GAP,
        `expected at least ${Scan.TICK_MIN_GAP}px between ticks`);
});

test('more prompts than the rail can hold merge into clusters', () => {
    const prompts = [];
    for (let i = 0; i < 40; i++) prompts.push({ ordinal: i + 1, line: i * 10 });
    // 20px of rail holds 5 ticks at a 4px pitch, so 40 prompts merge 8 to
    // a tick and the tooltip has a range to report.
    const ticks = Scan.layoutTicks(prompts, 400, 20);
    assert.equal(ticks.length, 5);
    assert.equal(ticks[0].ordinals.length, 8);
    assert.equal(ticks[0].ordinals[0], 1);
    assert.equal(ticks[4].ordinals[7], 40);
});

test('a rail with no measured height stacks at 0 rather than inventing one', () => {
    const ticks = Scan.layoutTicks(
        [{ ordinal: 1, line: 10 }, { ordinal: 2, line: 900 }], 1000, 0);
    assert.equal(ticks[0].y, 0);
    assert.equal(ticks[1].y, Scan.TICK_MIN_GAP);
});

test('the current ordinal is the last prompt at or above the viewport', () => {
    const prompts = [{ ordinal: 1, line: 5 }, { ordinal: 2, line: 50 },
                     { ordinal: 3, line: 500 }];
    assert.equal(Scan.currentOrdinalFor(prompts, 60), 2);
    assert.equal(Scan.currentOrdinalFor(prompts, 500), 3);
    // Above every prompt, the FIRST one is named rather than nothing.
    assert.equal(Scan.currentOrdinalFor(prompts, 0), 1);
    assert.equal(Scan.currentOrdinalFor([], 10), 0);
});

test('the module stays under the 500-line guideline', () => {
    const lines = fs.readFileSync(
        path.join(CLIENT_JS, 'terminal-prompt-scan.js'), 'utf8').split('\n').length;
    assert.ok(lines < 500,
        `terminal-prompt-scan.js is ${lines} lines, over the 500 limit`);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

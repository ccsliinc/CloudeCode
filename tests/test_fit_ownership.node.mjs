// ONE LAYOUT CHANGE, ONE MEASUREMENT, AT MOST ONE PANE RESIZE.
// ----------------------------------------------------------------------
// There were nine `fitAddon.fit()` call sites across five files and no
// single owner of when a fit is taken. Several of them fire in response
// to the same underlying event, so one layout change cost several
// measurements, and nothing in the system could state the invariant
// because nine callers each believed they were the only one.
//
// TWO THINGS ARE BEING OWNED HERE AND THEY ARE NOT THE SAME.
//
// THE MEASUREMENT is owned by TerminalMetrics.guardedFit, which refuses
// when xterm.css has not applied or when the proposed grid is
// implausible. That refusal is the whole reason it exists: a cell
// measured from an unstyled terminal produces a working-LOOKING grid
// matching nothing on screen, and sendResize then reflows the real tmux
// pane to it. CLAUDE.md records that incident under the CDN removal. So
// the assertion is not "a fit happened" but "no fit happened that did not
// go through the guard".
//
// THE SHIP is owned by TerminalLayout, which coalesces every announced
// and observed layout change into one debounced flush, asks
// TerminalResizeSettle whether the settled geometry is worth sending at
// all, and then calls sendResize exactly once.
//
// COUNTING IS THE TEST, AND TIMING IS NOT. A duplicate fit that happens
// to be fast is still a duplicate, and a wall clock on a loaded box
// would either flake or be too loose to prove anything. Everything here
// counts calls against a controller stand-in, so it cannot flake.
//
// Run with: node --test tests/test_fit_ownership.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LAYOUT_SRC = read('client/js/terminal-layout.js');
const SETTLE_SRC = read('client/js/terminal-resize-settle.js');

/**
 * Description: a realm holding the shipped layout pipeline and the
 *   settle rules, with a CONTROLLED clock so the debounce can be driven
 *   forward by hand instead of waited out.
 * Inputs: none.
 * Output: {window, run, controller, counts}.
 */
function makeRealm() {
    const timers = [];
    const counts = { guarded: 0, raw: 0, ships: [], enforce: 0 };

    const controller = {
        term: { cols: 100, rows: 40 },
        // A raw fit on this object is the defect. Nothing in the shipped
        // pipeline may reach it while the guard is available.
        fitAddon: { fit() { counts.raw += 1; } },
        lastSentCols: 0,
        lastSentRows: 0,
        sendResize(reason) { counts.ships.push(reason); },
    };

    const sandbox = {
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
        document: { getElementById: () => null, querySelector: () => null },
        addEventListener() {}, removeEventListener() {},
        ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SETTLE_SRC, sandbox, { filename: 'terminal-resize-settle.js' });
    vm.runInContext(LAYOUT_SRC, sandbox, { filename: 'terminal-layout.js' });

    // The measurement owner, instrumented. This is what a real browser
    // instrumentation of guardedFit would count.
    sandbox.window.TerminalMetrics = {
        guardedFit() { counts.guarded += 1; return { fitted: true, reason: 'ok' }; },
        enforceWidthFit() { counts.enforce += 1; return { changed: false }; },
        describeCellMetrics: () => '',
    };
    sandbox.window.TerminalLayout.install(controller);

    /** Run every timer currently armed, once. */
    const run = () => {
        const due = timers.splice(0, timers.length);
        for (const t of due) if (t.fn) t.fn();
    };
    return { window: sandbox.window, run, controller, counts };
}

// ---------------------------------------------- one change, one fit

test('a window resize produces exactly ONE measurement and ONE ship', () => {
    const { window: w, run, counts } = makeRealm();
    w.TerminalLayout.requestFit('window.resize');
    run();
    assert.equal(counts.guarded, 1, 'one layout change, one measurement');
    assert.equal(counts.raw, 0, 'and it went through the guard, not around it');
    assert.deepEqual(counts.ships, ['window.resize']);
});

test('a sidebar pin toggle produces exactly ONE measurement and ONE ship', () => {
    const { window: w, run, counts } = makeRealm();
    w.TerminalLayout.requestFit('sidebar-pin');
    run();
    assert.equal(counts.guarded, 1);
    assert.deepEqual(counts.ships, ['sidebar-pin']);
});

test('THE CASE THE OWNER EXISTS FOR: several sources for one change still fit once', () => {
    // A CSS class toggle fires the ResizeObserver once per frame AND the
    // caller announces it. Before a single owner, each of those was a
    // separate measurement and a separate pty_resize, and a pty_resize is
    // an ESC[2J on the alternate screen - the user's whole conversation.
    const { window: w, run, counts } = makeRealm();
    w.TerminalLayout.requestFit('sidebar-pin');
    w.TerminalLayout.requestFit('ResizeObserver');
    w.TerminalLayout.requestFit('ResizeObserver');
    w.TerminalLayout.requestFit('ResizeObserver');
    run();
    assert.equal(counts.guarded, 1,
        `one layout change took ${counts.guarded} measurements`);
    assert.equal(counts.ships.length, 1,
        `one layout change sent ${counts.ships.length} resizes to the pane`);
});

test('an UNANNOUNCED change settling back to the pane\'s own grid ships nothing', () => {
    // shouldShip's rule, unchanged: geometry equal to what tmux already
    // has costs an ESC[2J for nothing.
    const { window: w, run, controller, counts } = makeRealm();
    controller.lastSentCols = 100;
    controller.lastSentRows = 40;
    w.TerminalLayout.requestFit('ResizeObserver');
    run();
    assert.equal(counts.guarded, 1, 'it is still measured');
    assert.deepEqual(counts.ships, [], 'and deliberately not shipped');
});

test('POSITIVE CONTROL: an ANNOUNCED change at identical dims still ships', () => {
    // A human or the server did this on purpose. sendResize has its own
    // dedup for the no-op; this module must not become a second,
    // differently-behaved copy of that decision.
    const { window: w, run, controller, counts } = makeRealm();
    controller.lastSentCols = 100;
    controller.lastSentRows = 40;
    w.TerminalLayout.requestFit('window.resize');
    run();
    assert.deepEqual(counts.ships, ['window.resize']);
});

test('A REFUSED MEASUREMENT SHIPS NOTHING AND KEEPS THE LAST GOOD GRID', () => {
    // The load-bearing refusal. A fit taken before xterm.css applied
    // derives a bogus cell, and sendResize would reflow a real tmux pane
    // to a grid matching nothing on screen.
    const { window: w, run, counts } = makeRealm();
    w.TerminalMetrics.guardedFit = () => {
        counts.guarded += 1;
        return { fitted: false, reason: 'xterm-css-not-applied' };
    };
    w.TerminalLayout.requestFit('window.resize');
    run();
    assert.deepEqual(counts.ships, [],
        'a grid nobody could measure must never reach tmux');
    assert.equal(counts.raw, 0, 'and it must not fall back to an unguarded fit');
});

test('every ship carries a SOURCE NAME, never a bare call', () => {
    const { window: w, run, counts } = makeRealm();
    for (const source of ['window.resize', 'orientationchange', 'handshake']) {
        w.TerminalLayout.requestFit(source);
        run();
    }
    assert.deepEqual(counts.ships, ['window.resize', 'orientationchange', 'handshake']);
    for (const s of counts.ships) {
        assert.ok(s && s !== 'unknown', 'an unnamed resize cannot be diagnosed later');
    }
});

// ------------------------------------------- nothing fits off-owner

test('NO CALL SITE MEASURES OUTSIDE THE GUARD, across the whole client', () => {
    // The assertion is about the shape of the tree, so it reads the tree.
    // Four raw fits are legitimate and named here; anything else is a
    // caller that measured without asking whether the measurement could
    // be trusted.
    const allowed = new Map([
        // The guard itself. These two ARE the measurement.
        ['client/js/terminal-metrics.js', 2],
        // Module-missing fallbacks. Each sits in an else branch reached
        // only when TerminalMetrics did not load, where an unfitted
        // terminal is worse than an unguarded one.
        ['client/js/terminal-layout.js', 1],
        ['client/js/terminal-readiness.js', 1],
        ['client/js/terminal-scrollback-paint.js', 1],
    ]);
    const dir = path.join(ROOT, 'client/js');
    const offenders = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        const rel = 'client/js/' + name;
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        const hits = (src.match(/\bfitAddon(\s*&&\s*[\w.]+)?\.fit\(\)/g) || []).length;
        const budget = allowed.get(rel) || 0;
        if (hits > budget) offenders.push(`${rel}: ${hits} raw fits, ${budget} allowed`);
    }
    assert.deepEqual(offenders, [],
        'a raw fitAddon.fit() measures the character cell without asking '
        + 'whether xterm.css applied; route it through '
        + 'TerminalMetrics.guardedFit or TerminalLayout.requestFit');
});

test('the home screen no longer reaches into the terminal controller to fit', () => {
    // A layering violation independent of the duplicate-fit problem, and
    // an unguarded one: those numbers become the pane's BIRTH geometry,
    // so a grid from an unstyled cell births a real tmux pane at a size
    // matching nothing on screen.
    // Comments are allowed to NAME the thing that was removed - that is
    // how the next reader learns not to put it back - so this reads code
    // with the comment lines stripped.
    // THE 1.4.0 MERGE MOVED THIS RULE, IT DID NOT RETIRE IT.
    // `client/js/launchpad.js` is deleted and the rejoin path is
    // `web/src/lib/launchpad/nav-host.ts`. That file had the defect in
    // one of its two functions and not the other: `terminalDims()`
    // already went through the metrics owner while
    // `browserPrepareTerminal()` still fitted the addon itself, which is
    // exactly the kind of within-one-file inconsistency a guard aimed at
    // a deleted file stops catching.
    const src = read('web/src/lib/launchpad/nav-host.ts')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/fitAddon/.test(src),
        'nav-host.ts must ask TerminalMetrics for the grid, not fit it itself');
    assert.ok(src.includes('currentGrid()'),
        'the rejoin pre-fit must read the grid through the metrics owner');
    // BOTH readers, not just the one that was broken: a fix that left the
    // other reaching in would pass a check that only counted fitAddon.
    assert.equal((src.match(/currentGrid\(\)/g) || []).length, 2,
        'both terminalDims() and browserPrepareTerminal() read the grid, and '
        + 'both must read it the same way');
});

test('the rejoin path no longer awaits a bare animation frame', () => {
    // Gotcha 9: a browser does not run rAF callbacks for a tab it is not
    // painting, and the session fetch and the terminal entry both sit
    // below this wait - so a bare one does not delay the rejoin, it
    // cancels it.
    // Same move as above. web/src races the two frames against a timer
    // inside `twoFrames()` rather than calling into the classic
    // TerminalLayoutWait module, which is a different mechanism for the
    // same rule, so the assertion is on the RULE: no unraced rAF await.
    const src = read('web/src/lib/launchpad/nav-host.ts');
    const fn = src.slice(src.indexOf('function twoFrames('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/setTimeout\(/.test(body),
        'the wait must be raced against a timer, or a tab the browser is not '
        + 'painting never resolves it and the rejoin is cancelled, not delayed');
    assert.ok(/requestAnimationFrame/.test(body),
        'and it must still prefer the frame when there is one');
});

test('every pane resize leaves through sendResize, and each names its source', () => {
    // sendResize is the ONLY path to tmux. A client-side fit not followed
    // by it leaves xterm and the pty disagreeing about the grid, which is
    // what "tmux does not resize" looks like from the user's seat.
    const sites = [];
    const dir = path.join(ROOT, 'client/js');
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(dir, name), 'utf8')
            .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        for (const m of src.matchAll(/\.sendResize\(([^)]*)\)/g)) {
            if (/^\s*source\b/.test(m[1])) continue;   // the definition itself
            sites.push(`client/js/${name}: sendResize(${m[1]})`);
        }
    }
    assert.equal(sites.length, 3,
        `${sites.length} ship sites: ${sites.join(' | ')}. The coalescer plus `
        + 'the two handshake-shaped ones is the whole set; a fourth needs a '
        + 'reason written down');
    // A literal for the two that know their own source, and the
    // coalescer's `reason` - which IS a source name, forwarded from
    // whichever requestFit produced it. What must never appear is a bare
    // sendResize(), because a resize nobody can attribute cannot be
    // diagnosed from a log six weeks later.
    for (const s of sites) {
        assert.ok(/sendResize\(\s*('[a-z.\-]+'|reason)/.test(s),
            `a ship with no source name: ${s}`);
    }
});

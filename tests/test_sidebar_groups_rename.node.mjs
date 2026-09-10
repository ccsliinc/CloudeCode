// Items 64, 65 and 66 at the unit level: the group partition and its two
// rendering rules, the collapsed preference's grading, and the rename
// gate's three states.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TEST: anything that needs a real
// box. Header height, the boundary's painted position, whether a
// collapsed group leaves rows in the DOM, whether the chevron actually
// rotates, and whether a drag across the seam works with real pointer
// events are all measured in a real Chromium by
// scripts/verify_sidebar_groups.py. Splitting it that way is the point -
// this project shipped 282 green state assertions over zero rendered
// pixels, so a state assertion here is never allowed to stand in for a
// pixel there.

import assert from 'node:assert/strict';
import {
    Doc, fakeStorage, loadModules, plain, repoFile, results, test,
} from './lib-sidebar-sessions.mjs';

const ARRANGEMENT_KEY = 'cloude.session.sidebar.arrangement';

/**
 * Description: load the store + arrangement + rows + groups stack over one
 *   fake storage, which is the smallest set that can render a grouped list.
 * Inputs: stored (string|null) - the raw arrangement envelope on disk.
 * Output: object - {A, G, Rows, storage}.
 */
function loadStack(stored) {
    const storage = fakeStorage(stored === null ? {} : { [ARRANGEMENT_KEY]: stored });
    // status-led.js and session-status-summary.js are in the stack because
    // the header's summary LED is real behaviour, not decoration: it is
    // the ONLY thing that speaks for a section the user has folded. This
    // file used to load neither, so `window.SessionStatusSummary` was
    // absent, `headerHtml` took its "render the header without a LED"
    // branch, and every assertion here was green over a header that
    // painted no light at all. Loading the modules the browser loads is
    // what let the 2026-09-09 unknown/dim defect be caught here.
    const { window } = loadModules([
        'status-led.js', 'session-status-summary.js',
        'session-sidebar-store.js', 'session-sidebar-arrangement.js',
        'session-sidebar-rows.js', 'session-sidebar-groups.js',
    ], { storage, document: new Doc() });
    return {
        A: window.SessionSidebarArrangement,
        G: window.SessionSidebarGroups,
        Rows: window.SessionSidebarRows,
        storage,
    };
}

/**
 * Description: one attachable-probe row, with overrides.
 * Inputs: over (object). Output: object.
 */
function row(over = {}) {
    return {
        name: 'cloude_a',
        created_by_cloude: true,
        created_at_epoch: 1_700_000_000,
        status: 'working',
        unread: false,
        is_pinned: false,
        ...over,
    };
}

// =====================================================================
// ITEM 64 - THE TWO RULES ABOUT WHEN A HEADER EXISTS AT ALL.
// =====================================================================

await test('ITEM 64: an EMPTY pinned group renders nothing, not a bare header', () => {
    const { G } = loadStack(null);
    const html = G.bodyHtml([row({ name: 'a' }), row({ name: 'b' })], 'cozy', null, {});
    assert.ok(!html.includes('session-sidebar-group__header'),
        'a header for a band the user has never put anything in asks a question nobody asked');
    assert.ok(!html.includes('session-sidebar-group'), 'and no group wrapper either');
});

await test('ITEM 64: with nothing pinned the REST renders ungrouped too', () => {
    // Headers exist to SEPARATE. With one band there is nothing to
    // separate it from, so a lone "other" header over the whole list would
    // be a label pretending to be a division.
    const { G } = loadStack(null);
    const html = G.bodyHtml([row({ name: 'a' })], 'cozy', null, {});
    assert.ok(html.includes('session-sidebar-row'), 'the rows still render');
    assert.ok(!html.includes('>other<'), 'but no lone section label over them');
});

await test('ITEM 64: the seam appears exactly when there IS a seam', () => {
    const { G } = loadStack(null);
    const html = G.bodyHtml(
        [row({ name: 'p', is_pinned: true }), row({ name: 'a' })], 'cozy', null, {});
    assert.ok(html.includes('data-group="pinned"'), 'the pinned group is drawn');
    assert.ok(html.includes('data-group="other"'), 'and so is the other one');
    assert.ok(html.indexOf('data-group="pinned"') < html.indexOf('data-group="other"'),
        'pinned comes FIRST, which is the whole request');
});

await test('ITEM 64: a drag in flight draws the EMPTY pinned group as a drop target', () => {
    // The one exception to rule 1. A target that only exists once you have
    // already hit it cannot be hit.
    const { G } = loadStack(null);
    const html = G.bodyHtml([row({ name: 'a' })], 'cozy', null, { dragging: true });
    assert.ok(html.includes('data-group="pinned"'),
        'an empty pinned group must be droppable DURING a drag');
    assert.ok(html.includes('data-count="0"'), 'and it says it is empty');
});

await test('ITEM 64: the moment the drag ends the empty group disappears again', () => {
    const { G } = loadStack(null);
    const during = G.bodyHtml([row({ name: 'a' })], 'cozy', null, { dragging: true });
    const after = G.bodyHtml([row({ name: 'a' })], 'cozy', null, { dragging: false });
    assert.ok(during.includes('data-group="pinned"'));
    assert.ok(!after.includes('session-sidebar-group'), 'steady state is still rule 1');
});

await test('ITEM 64: a COLLAPSED group emits no rows at all, not hidden ones', () => {
    // The reorder path reads the visible order off the DOM with
    // querySelectorAll, which finds a `hidden` element just as happily as
    // a visible one - so a fold that left the rows in place would leave
    // every reorder and every drag computing against rows nobody can see.
    const { G } = loadStack(null);
    const rows = [row({ name: 'p', is_pinned: true }), row({ name: 'a' })];
    const html = G.bodyHtml(rows, 'cozy', { collapsed: ['pinned'] }, {});
    const bodies = html.split('session-sidebar-group__body');
    assert.ok(html.includes('data-collapsed="1"'), 'the group reports itself collapsed');
    assert.ok(!html.includes('data-name="p"'), 'and its row is not in the markup at all');
    assert.ok(html.includes('data-name="a"'), 'the open group still renders');
    assert.ok(bodies.length > 1, 'the body element still exists so aria-controls resolves');
});

await test('ITEM 64: a collapsed group still SAYS how much it hides', () => {
    const { G } = loadStack(null);
    const rows = [
        row({ name: 'p', is_pinned: true }), row({ name: 'q', is_pinned: true }),
        row({ name: 'a' }),
    ];
    const html = G.bodyHtml(rows, 'cozy', { collapsed: ['pinned'] }, {});
    assert.ok(/data-group="pinned" data-collapsed="1" data-count="2"/.test(html),
        'or a collapsed group and an empty one look identical');
});

await test('ITEM 64: the header carries aria-expanded matching the fold', () => {
    const { G } = loadStack(null);
    const rows = [row({ name: 'p', is_pinned: true }), row({ name: 'a' })];
    const open = G.bodyHtml(rows, 'cozy', { collapsed: [] }, {});
    const shut = G.bodyHtml(rows, 'cozy', { collapsed: ['pinned'] }, {});
    assert.ok(open.includes('aria-expanded="true"'));
    assert.ok(shut.includes('aria-expanded="false"'),
        'the fold must not be shape-only - a chevron is not an announcement');
});

await test('ITEM 64: split() reads is_pinned and never re-decides it', () => {
    const { G } = loadStack(null);
    const bands = G.split([
        row({ name: 'p', is_pinned: true }), row({ name: 'a' }), row({ name: 'b' }),
    ]);
    assert.deepEqual(plain(bands.pinned).map((r) => r.name), ['p']);
    assert.deepEqual(plain(bands.other).map((r) => r.name), ['a', 'b']);
});

// =====================================================================
// ITEM 64 - THE COLLAPSED PREFERENCE IS GRADED AS A PREFERENCE.
// =====================================================================

await test('the fold rides the SAME key as the pins and the order', () => {
    const { A, storage } = loadStack(null);
    A.load();
    A.save(['p'], ['p', 'a']);
    A.toggleCollapsed('pinned');
    const stored = JSON.parse(storage.map.get(ARRANGEMENT_KEY));
    assert.deepEqual(plain(stored.collapsed), ['pinned']);
    assert.deepEqual(plain(stored.pinned), ['p'], 'and the pins are still there');
    assert.equal(stored.v, 1, 'the version is NOT bumped for an additive optional field');
});

await test('a fold does NOT bump the version, or every stored arrangement dies', () => {
    // Bumping VERSION to 2 would have declared every arrangement already
    // on disk unreadable, so every existing user would open the bar to a
    // CANNOT LOAD notice and a default order - breaking the exact thing
    // this module exists to protect in order to store a preference.
    const { A } = loadStack(JSON.stringify({ v: 1, pinned: ['p'], order: ['p', 'a'] }));
    const st = A.load();
    assert.equal(st.status, 'ok', 'an envelope with no collapsed key still parses');
    assert.deepEqual(plain(st.collapsed), [], 'and reads as nothing collapsed');
});

await test('a MALFORMED collapsed list is a preference miss, not an unreadable arrangement', () => {
    // The order is the user's DATA and a bad one is announced. A fold is a
    // PREFERENCE and there is nothing of the user's to lose, so it falls
    // back silently to "nothing collapsed" and the pins still load.
    const { A } = loadStack(JSON.stringify({
        v: 1, pinned: ['p'], order: ['p', 'a'], collapsed: 'yes please',
    }));
    const st = A.load();
    assert.equal(st.status, 'ok', 'a bad fold must not condemn the whole arrangement');
    assert.deepEqual(plain(st.pinned), ['p'], 'the pins survive it');
    assert.deepEqual(plain(st.collapsed), []);
});

await test('an UNKNOWN section key is dropped, so no fold can become unreopenable', () => {
    const { A } = loadStack(JSON.stringify({
        v: 1, pinned: [], order: [], collapsed: ['pinned', 'archived'],
    }));
    assert.deepEqual(plain(A.load().collapsed), ['pinned']);
});

await test('toggling a section that does not exist changes nothing', () => {
    const { A } = loadStack(null);
    A.load();
    assert.equal(A.toggleCollapsed('nope'), false);
    assert.deepEqual(plain(A.current().collapsed), []);
});

await test('a reorder does not silently reopen a section the user folded', () => {
    const { A } = loadStack(null);
    A.load();
    A.save(['p'], ['p', 'a', 'b']);
    A.toggleCollapsed('other');
    A.move('a', 1, ['p', 'a', 'b']);
    assert.deepEqual(plain(A.current().collapsed), ['other'],
        'save() must pass the live folds through, not default them away');
});

// =====================================================================
// ITEM 66 - THE RENAME GATE HAS THREE STATES.
// =====================================================================

await test('ITEM 66: a live session id means RENAMEABLE', () => {
    const { Rows } = loadStack(null);
    const st = Rows.renameState({ session_id: 'sess-1', created_by_cloude: true });
    assert.equal(st.state, 'renameable');
});

await test('ITEM 66: no id but KNOWN ownership is unavailable, and says the precondition', () => {
    const { Rows } = loadStack(null);
    const ours = Rows.renameState({ session_id: null, created_by_cloude: true });
    const theirs = Rows.renameState({ session_id: null, created_by_cloude: false });
    assert.equal(ours.state, 'unavailable');
    assert.equal(theirs.state, 'unavailable');
    assert.notEqual(ours.reason, theirs.reason,
        'open it vs adopt it are different instructions and must read differently');
    assert.match(ours.reason, /open/);
    assert.match(theirs.reason, /adopt/);
});

await test('ITEM 66: null ownership is UNKNOWN, never folded into external', () => {
    // `== null` catches null and undefined and nothing else, deliberately.
    // A `!r.created_by_cloude` test would fold the genuine unknown into
    // "external" and invent an answer nobody measured.
    const { Rows } = loadStack(null);
    for (const v of [null, undefined]) {
        const st = Rows.renameState({ session_id: null, created_by_cloude: v });
        assert.equal(st.state, 'unknown', `created_by_cloude=${String(v)}`);
        assert.match(st.reason, /CANNOT DETERMINE/);
    }
});

await test('ITEM 66: false ownership is NOT unknown - the two must stay apart', () => {
    const { Rows } = loadStack(null);
    assert.equal(
        Rows.renameState({ session_id: null, created_by_cloude: false }).state,
        'unavailable',
        'a known-external session is a different sentence from one we cannot classify');
});

await test('ITEM 66: the row DRAWS its rename state, so the editor cannot disagree with it', () => {
    const { Rows } = loadStack(null);
    const html = Rows.rowHtml(row({ session_id: 'sess-1' }), 'cozy');
    assert.ok(html.includes('data-rename-state="renameable"'));
    const blocked = Rows.rowHtml(row({ session_id: null, created_by_cloude: null }), 'cozy');
    assert.ok(blocked.includes('data-rename-state="unknown"'));
});

await test('ITEM 66: the rename state is in the SIGNATURE, or a row never repaints', () => {
    // A session that has just opened would otherwise keep telling the user
    // it could not be renamed until something unrelated happened to move.
    const { Rows } = loadStack(null);
    const before = Rows.signature([row({ session_id: null })], 'cozy', { ok: true }, []);
    const after = Rows.signature([row({ session_id: 'sess-1' })], 'cozy', { ok: true }, []);
    assert.notEqual(before, after);
});

await test('ITEM 64: the FOLD is in the signature, or collapsing paints nothing', () => {
    const { Rows } = loadStack(null);
    const rows = [row({ name: 'a' })];
    assert.notEqual(
        Rows.signature(rows, 'cozy', { ok: true }, [], { collapsed: [] }),
        Rows.signature(rows, 'cozy', { ok: true }, [], { collapsed: ['pinned'] }),
        'folding a section is the largest change this list can make to itself');
    assert.notEqual(
        Rows.signature(rows, 'cozy', { ok: true }, [], { dragging: false }),
        Rows.signature(rows, 'cozy', { ok: true }, [], { dragging: true }),
        'and the drag flag is what makes the empty pinned group appear');
});

await test('ITEM 66: the editor enforces the LABEL rule, not the old tmux-name rule', () => {
    // THIS TEST USED TO ASSERT THE BUG. It read
    // `assert.ok(!R.NAME_RE.test('has space'))` - a space must be
    // REFUSED - which is the old `^[A-Za-z0-9_-]{1,64}$` tmux-name rule
    // applied to a field that is no longer a tmux name. A label is never
    // handed to tmux, so tmux's constraints do not apply to it, and the
    // feature's own worked example ("Media Compression") was refused in
    // the browser before it could reach a server that accepts it.
    //
    // The editor now holds no copy of the rule at all: it delegates to
    // SessionLabel.validate, so this asserts through the same door the
    // editor uses rather than against a second regex.
    const storage = fakeStorage();
    const { window } = loadModules(
        ['session-label.js', 'session-sidebar-rename.js'],
        { storage, document: new Doc() },
    );
    const R = window.SessionSidebarRename;

    // THE WHOLE POINT OF THE FEATURE: punctuation a tmux name cannot
    // carry is legal in a label.
    for (const good of ['Media Compression', 'client: acme', 'v1.2 "final"', 'cost $5', 'ok']) {
        assert.equal(R.validateLabel(good).ok, true, `${good} must be a legal label`);
    }
    // Non-ASCII too. tmux does not preserve it, which is why a LABEL may
    // legitimately differ from its handle by more than the filter.
    assert.equal(R.validateLabel('emoji \u{1F680} ok').ok, true);

    // Surrounding whitespace is the one silent correction, as on the server.
    // Field-by-field rather than deepEqual: the verdict object is
    // constructed inside the module's own VM realm, so a structural
    // comparison fails on prototype identity alone and says nothing
    // about the value.
    const trimmed = R.validateLabel('  Media Compression  ');
    assert.equal(trimmed.ok, true);
    assert.equal(trimmed.value, 'Media Compression');

    // AND THE TWO REFUSALS THE SERVER ACTUALLY MAKES.
    assert.equal(R.validateLabel('').ok, false, 'empty is refused');
    assert.equal(R.validateLabel('   ').ok, false, 'whitespace-only is refused');
    assert.equal(R.validateLabel(null).ok, false, 'null is refused');
    assert.equal(R.validateLabel('a\nb').ok, false, 'a newline is a control char');
    assert.equal(R.validateLabel('a\tb').ok, false, 'a tab is a control char');

    // THE LIMIT IS THE LABEL'S, NOT THE TMUX NAME'S. 65 characters used
    // to be refused here; the boundary is now 200, and both sides of it
    // are asserted so a limit that drifted in either direction fails.
    const max = window.SessionLabel.LABEL_MAX_CHARS;
    assert.equal(max, 200, 'the mirrored server limit');
    assert.equal(R.validateLabel('x'.repeat(65)).ok, true, '65 is fine for a label');
    assert.equal(R.validateLabel('x'.repeat(max)).ok, true, 'exactly the limit is fine');
    assert.equal(R.validateLabel('x'.repeat(max + 1)).ok, false, 'one over is refused');
});

// =====================================================================
// HOUSEKEEPING.
// =====================================================================

await test('every file this round added stays under the 500-line budget', () => {
    const files = [
        ['js', 'session-sidebar-groups.js'], ['js', 'session-sidebar-rename.js'],
        ['js', 'session-sidebar-store.js'], ['js', 'session-sidebar-clicks.js'],
        ['css', 'session-sidebar-groups.css'],
    ];
    for (const [dir, f] of files) {
        const lines = repoFile('client', dir, f).split('\n').length;
        assert.ok(lines <= 500, `${f} is ${lines} lines, over the 500 budget`);
    }
});

await test('nothing added this round uses an em-dash, an en-dash, or an emoji', () => {
    const files = [
        ['client', 'js', 'session-sidebar-groups.js'],
        ['client', 'js', 'session-sidebar-rename.js'],
        ['client', 'js', 'session-sidebar-store.js'],
        ['client', 'js', 'session-sidebar-clicks.js'],
        ['client', 'css', 'session-sidebar-groups.css'],
    ];
    // The dash characters are built from their code points rather than
    // written literally, so this file does not violate the rule it is
    // enforcing - which is the trap the repo's own portability lint hit
    // when prose about a construct counted as a use of it.
    const EM = String.fromCharCode(8212);
    const EN = String.fromCharCode(8211);
    for (const parts of files) {
        const src = repoFile(...parts);
        assert.ok(!src.includes(EM), `${parts.join('/')} has an em-dash`);
        assert.ok(!src.includes(EN), `${parts.join('/')} has an en-dash`);
        assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(src),
            `${parts.join('/')} has an emoji`);
    }
});

await test('every module this round added is actually SERVED', () => {
    // A file nobody loads is dead code, and a stylesheet nobody links is
    // the specific failure that made this whole round render unstyled
    // while every DOM assertion passed.
    const html = repoFile('client', 'index.html');
    for (const f of ['session-sidebar-groups.js', 'session-sidebar-rename.js',
        'session-sidebar-store.js', 'session-sidebar-clicks.js']) {
        assert.ok(html.includes(`/static/js/${f}`), `${f} is not served`);
    }
    assert.ok(html.includes('/static/css/session-sidebar-groups.css'),
        'the groups stylesheet is not linked');
});

await test('the store loads BEFORE the arrangement that reads through it', () => {
    const html = repoFile('client', 'index.html');
    const idx = (f) => html.indexOf(`/static/js/${f}`);
    assert.ok(idx('session-sidebar-store.js') < idx('session-sidebar-arrangement.js'));
    assert.ok(idx('session-sidebar-rows.js') < idx('session-sidebar-groups.js'));
    assert.ok(idx('session-sidebar-clicks.js') < idx('session-sidebar.js'),
        'the controller delegates into clicks, so clicks must exist first');
});

await test('every class the groups module EMITS has a CSS rule somewhere', () => {
    // THE CHECK THIS ROUND NEEDED AND DID NOT HAVE. index.html linked a
    // stylesheet that did not exist and every class below was already
    // being emitted, so the feature rendered as an unstyled pile while
    // every DOM assertion passed. A class with no rule is a missing
    // FEATURE, not a missing style.
    const emitted = new Set();
    for (const f of ['session-sidebar-groups.js', 'session-sidebar-rename.js']) {
        const src = repoFile('client', 'js', f);
        for (const m of src.matchAll(/class="([^"$]+)"/g)) {
            for (const c of m[1].split(/\s+/)) if (c.startsWith('session-sidebar')) emitted.add(c);
        }
    }
    assert.ok(emitted.size >= 6, `expected the group classes, found ${emitted.size}`);
    const css = repoFile('client', 'css', 'session-sidebar-groups.css')
        + repoFile('client', 'css', 'session-sidebar-density.css')
        + repoFile('client', 'css', 'session-sidebar.css');
    for (const c of emitted) {
        assert.ok(css.includes(`.${c}`), `${c} is emitted but has no CSS rule anywhere`);
    }
});

await test('the density contract is DECLARED in the stylesheet, not left to add up', () => {
    const css = repoFile('client', 'css', 'session-sidebar-density.css');
    for (const [mode, px] of [['compact', 24], ['cozy', 46], ['detailed', 66]]) {
        const re = new RegExp(
            `\\[data-density="${mode}"\\]\\s*\\.session-sidebar-row\\s*\\{[^}]*min-height:\\s*${px}px`);
        assert.ok(re.test(css), `${mode} must declare min-height: ${px}px`);
    }
});

// =====================================================================
// SIDEBAR HEADER LAYOUT: count gutter first, kebab everywhere.
// "on side bar, the session count first make a gutter so they all line
// up. the pinned and the other doest have a kebab. maybe just give it
// one. and the number make it a colored font and not circle."
// =====================================================================

await test('every header carries a kebab, pinned and other included', () => {
    const { G } = loadStack(null);
    const html = G.bodyHtml(
        [row({ name: 'p', is_pinned: true }), row({ name: 'a' })], 'cozy', null, {});
    assert.ok(html.includes('data-group-menu-band="pinned"'),
        'pinned gets a kebab even though it is not a real group');
    assert.ok(html.includes('data-group-menu-band="other"'),
        'other gets one too');
});

await test('the count sits in a fixed gutter, ahead of the fold toggle', () => {
    const { G } = loadStack(null);
    const html = G.headerHtml('pinned', 3, false, undefined);
    assert.ok(html.includes('session-sidebar-group__gutter'), 'the gutter wraps the count');
    assert.ok(
        html.indexOf('session-sidebar-group__gutter') < html.indexOf('data-group-toggle'),
        'the gutter renders before the fold toggle, not after it');
    assert.ok(html.includes('<span class="session-sidebar-group__count">3</span>'),
        'the count is plain text inside its own span');
});

await test('the group count is coloured text, not a pill badge', () => {
    const css = repoFile('client', 'css', 'session-sidebar-groups.css');
    const m = css.match(/\.session-sidebar-group__count\s*\{([^}]*)\}/);
    assert.ok(m, 'the count rule exists');
    assert.ok(!/border-radius/.test(m[1]), 'no pill radius left on the count');
    assert.ok(!/background/.test(m[1]), 'no badge fill left on the count');
    assert.ok(/color:\s*var\(--color-accent\)/.test(m[1]), 'plain coloured text');
    assert.ok(/tabular-nums/.test(m[1]), 'digits stay a constant width');
});

await test('the sidebar gutter is a sibling token of --project-gutter', () => {
    const tokens = repoFile('client', 'css', 'styles.css');
    assert.ok(tokens.includes('--sidebar-gutter:'), 'a dedicated token exists in styles.css');
    const gutterRule = repoFile('client', 'css', 'session-sidebar-groups.css')
        .match(/\.session-sidebar-group__gutter\s*\{([^}]*)\}/);
    assert.ok(gutterRule, 'the gutter class has a rule');
    assert.ok(/var\(--sidebar-gutter\)/.test(gutterRule[1]),
        'the gutter reads the shared token rather than a hardcoded width');
});

// =====================================================================
// THE HEADER IS SUMMARISED FROM THE ROWS, NEVER FROM THE DOM.
//
// A folded section emits no rows at all (see ITEM 64 above), so anything
// that read the section's state back out of the markup would go silent at
// exactly the moment the header's LED is the only thing left saying what
// is inside. `sectionHtml` passes `rows` to `headerHtml` whether or not
// the section is collapsed; these tests are what hold that.
// =====================================================================

/**
 * Description: the (inner, outer) pair on one section header's summary
 *   LED. Scoped to that section's own slice of the markup so a two-group
 *   render cannot have one header's light read for another's.
 * Inputs: html (string) - a bodyHtml render. key (string) - band key.
 * Output: object|null - {inner, outer}, or null when no LED is present.
 */
function headerLed(html, key) {
    const start = html.indexOf(`data-group="${key}"`);
    if (start < 0) return null;
    const next = html.indexOf('data-group="', start + 1);
    const slice = html.slice(start, next < 0 ? html.length : next);
    const summary = slice.indexOf('session-sidebar-group__summary');
    if (summary < 0) return null;
    const m = slice
        .slice(summary)
        .match(/data-inner="([^"]+)" data-outer="([^"]+)"/);
    return m ? { inner: m[1], outer: m[2] } : null;
}

await test('the header LED reads the ROWS, and says what a group holds', () => {
    const { G } = loadStack(null);
    const rows = [
        row({ name: 'p', is_pinned: true, status: 'idle' }),
        row({ name: 'q', is_pinned: true, status: 'idle' }),
        row({ name: 'a', status: 'working' }),
    ];
    const html = G.bodyHtml(rows, 'cozy', null, {});
    assert.deepEqual(headerLed(html, 'pinned'), { inner: 'idle', outer: 'steady' },
        'an all-idle section is idle, not unknown');
    assert.deepEqual(headerLed(html, 'other'), { inner: 'working', outer: 'active' },
        'and a section holding a working session says so');
});

await test('a COLLAPSED group is still summarised, from rows it does not render', () => {
    // The whole point. The folded section has no rows in the markup, so a
    // header that had to find them there would report unknown for exactly
    // the sections the user cannot see into.
    const { G } = loadStack(null);
    const rows = [
        row({ name: 'p', is_pinned: true, status: 'question' }),
        row({ name: 'a', status: 'idle' }),
    ];
    const html = G.bodyHtml(rows, 'cozy', { collapsed: ['pinned'] }, {});
    assert.ok(!html.includes('data-name="p"'), 'its row really is absent from the markup');
    assert.deepEqual(headerLed(html, 'pinned'),
        { inner: 'waiting-permission', outer: 'active' },
        'and the header still reports the parked session inside it');
});

await test('folding a group does not change what its header claims', () => {
    const { G } = loadStack(null);
    const rows = [
        row({ name: 'p', is_pinned: true, status: 'working' }),
        row({ name: 'q', is_pinned: true, status: 'idle', unread: true }),
        row({ name: 'a', status: 'idle' }),
    ];
    const open = G.bodyHtml(rows, 'cozy', { collapsed: [] }, {});
    const shut = G.bodyHtml(rows, 'cozy', { collapsed: ['pinned'] }, {});
    assert.deepEqual(headerLed(shut, 'pinned'), headerLed(open, 'pinned'),
        'the fold is a view state and must not move the roll-up');
    assert.deepEqual(headerLed(open, 'pinned'), { inner: 'working', outer: 'active' });
});

await test('a header over live members NEVER reads unknown', () => {
    // The defect the owner reported, as a direct assertion: every group
    // with a measured member has to say something about it.
    const { G } = loadStack(null);
    const states = ['working', 'question', 'notice', 'finished_unread', 'idle', 'dead'];
    for (const state of states) {
        const rows = [
            row({ name: 'p', is_pinned: true, status: state }),
            row({ name: 'a', status: 'idle' }),
        ];
        const html = G.bodyHtml(rows, 'cozy', { collapsed: ['pinned'] }, {});
        const led = headerLed(html, 'pinned');
        assert.ok(led, `a header with a ${state} member renders a LED`);
        assert.notEqual(led.inner, 'unknown', `${state} member must not read unknown`);
        assert.notEqual(led.outer, 'dim', `${state} member must not read dim`);
    }
});

const { passes, failures } = results();
console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
console.log('ALL PASS');

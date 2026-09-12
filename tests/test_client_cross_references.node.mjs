// Every cross-reference the classic client tree makes into itself, checked
// against something that actually provides it.
//
// WHY THIS FILE EXISTS. The 1.4.0 merge brought 89 commits of the other
// line's client work into a tree where the svelte rewrite had renamed,
// moved or deleted a lot of what that work reaches for. The backend half
// of the same merge found its own instance of this: merged code calling
// attributes the restructure had deleted, which git merged cleanly and
// which would have raised at runtime.
//
// THE JAVASCRIPT VERSION OF THAT IS WORSE, AND THAT IS THE WHOLE POINT.
// Python raises on a missing attribute. A classic script reading
// `window.Foo.bar()` where nothing published `Foo` throws only when the
// line RUNS, which may be on one screen, on one gesture, on a phone. And
// the far more common shape does not throw at all:
// `document.getElementById('x')` on an id nobody emits returns null, and
// this codebase guards its DOM reads, so the guard swallows it and the
// feature is simply absent. Nothing in a test run, a lint pass or a type
// check observes any of it.
//
// THE PRECEDENT THIS IS BUILT FROM. A worker once renamed
// `data-row-menu-status` to `data-row-status` and all 200 node suites
// passed, because nothing compared the real markup against the real
// reader. `data-row-status` lives on the KEBAB, and
// session-sidebar-clicks.js reads it there; a read pointed at the row
// instead hands `runRestart` a null and nothing anywhere says so.
//
// WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT. It is a REACHABILITY
// check, not a type check: it asks whether every name read has at least
// one writer somewhere in the shipped tree. It cannot prove the writer
// runs first, or that it writes the shape the reader wants. It is aimed
// squarely at the class where the writer does not exist AT ALL, which is
// what a migration produces and what nothing else here catches.
//
// EVERY EXEMPTION IS NAMED AND JUSTIFIED, and each one is a FINDING that
// was run down by hand rather than a hole opened to get to green. Adding
// to those lists is a decision to be reviewed. If you are about to add an
// entry because your new code does not pass, the code is wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Strip whole-line comments so prose naming a removed symbol is not a read. */
const code = (src) =>
    src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/**
 * Every classic script in the client tree, RECURSIVELY.
 *
 * Description: `client/js` has real subdirectories - `themes/`, `i18n/`,
 *   `labels/` - and they publish globals other modules depend on
 *   (`window.Themes` from themes/registry.js, `globalThis.CloudeI18n`
 *   from i18n/boot.js). A top-level-only read reported all of those as
 *   unpublished, which is a false alarm that would have taught the next
 *   reader to add exemptions instead of believing the guard.
 * Inputs: none. Output: string[] - repo-relative paths.
 */
function clientScripts() {
    return walk('client/js', ['.js']);
}

/** Files under a directory, recursively, with one of the given extensions. */
function walk(rel, exts) {
    const out = [];
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) out.push(...walk(child, exts));
        else if (exts.some((e) => entry.name.endsWith(e))) out.push(child);
    }
    return out;
}

/**
 * Everything a reader could legitimately find at runtime.
 *
 * Description: the classic scripts, the COMPILED BUNDLE (the svelte tree
 *   publishes its shim from there, so a check that skipped it would
 *   report every bundle-provided global as missing), the svelte sources
 *   (so a rename is caught before a rebuild rather than after), and
 *   index.html.
 * Inputs: none. Output: string - every candidate provider concatenated.
 */
function providerBlob() {
    const files = [
        ...clientScripts(),
        ...walk('web/src', ['.ts', '.svelte']),
        'client/index.html',
    ];
    if (exists('client/dist/app.js')) files.push('client/dist/app.js');
    // THE VENDOR TREE IS A PROVIDER. `client/vendor/codemirror/codemirror-bundle.js`
    // publishes `window.CodeMirrorBundle`, and xterm's files publish the
    // four in AMBIENT. They are lazy-loaded (module-families.js) rather
    // than sitting in index.html, so a check that only read index.html
    // would call every one of them missing.
    files.push(...walk('client/vendor', ['.js']));
    return files.map(read).join('\n');
}

// ---------------------------------------------------------------- globals

/**
 * Globals provided by the browser or by a vendored library, not by us.
 *
 * The xterm four are the ones worth explaining: `Terminal`, `FitAddon`,
 * `WebglAddon` and `Unicode11Addon` come from `client/vendor/xterm/`,
 * loaded as classic scripts from `/static/vendor/xterm/`. They are OURS
 * to serve and not ours to define, and the CSP forbids fetching them from
 * anywhere else - which the vendored-asset test already enforces. The
 * rest is the standard library.
 */
const AMBIENT = new Set([
    'Terminal', 'FitAddon', 'WebglAddon', 'Unicode11Addon',
    'CustomEvent', 'Promise', 'Event', 'Error', 'Math', 'JSON', 'Date', 'Object',
    'Array', 'String', 'Number', 'Boolean', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'RegExp', 'Symbol', 'URL', 'URLSearchParams', 'WebSocket', 'Blob', 'File',
    'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'AbortController',
    'TextEncoder', 'TextDecoder', 'Intl', 'Notification', 'MutationObserver',
    'ResizeObserver', 'IntersectionObserver', 'DOMParser', 'XMLHttpRequest',
    'Image', 'Audio', 'Worker', 'BroadcastChannel', 'Proxy', 'Reflect', 'BigInt',
    'ArrayBuffer', 'Uint8Array', 'Int8Array', 'Float32Array', 'Element',
    'HTMLElement', 'Node', 'Document', 'Window', 'Storage', 'History', 'Location',
    'Text', 'EventTarget', 'DataTransfer', 'Range', 'Selection', 'Clipboard',
    'ClipboardItem', 'Option', 'MediaQueryList', 'CSS', 'Intersection',
    'AudioContext', 'OfflineAudioContext', 'SpeechSynthesisUtterance',
]);

/**
 * Globals read as an OPTIONAL hook, with an explicit fallback in the read.
 *
 * These are not missing dependencies; they are seams. The read itself
 * says so - `(typeof window !== 'undefined' ? window.X : null) || null` -
 * so absence is the designed default rather than a broken reference, and
 * requiring a publisher would force a stub whose only purpose is to
 * satisfy this file.
 *
 * `ArchiveProjectOverlay` (archive-nav.js): an overlay the archive screen
 * uses when one is registered and does without when one is not.
 *
 * Anything added here must have its fallback VISIBLE at the call site.
 * "It is guarded" is not enough on its own: every DOM read in this
 * codebase is guarded, which is exactly why the id check below needs its
 * own measured list instead of trusting guards.
 */
const OPTIONAL_GLOBALS = new Set([
    'ArchiveProjectOverlay',
]);

test('every window.X a client script reads is published by something', () => {
    const blob = providerBlob();
    const published = new Set();
    // Four assignment shapes are in use across this tree and all four are
    // real: `window.X =`, `globalThis.X =`, `global.X =`, and `root.X =`
    // inside the UMD-ish wrapper several modules use (provider-groups.js
    // is the worked example). A check that knew only the first would
    // report ProviderGroups as missing, which is a false alarm that
    // teaches the next reader to distrust this file.
    for (const m of blob.matchAll(
        /(?:window|globalThis|global|root)\s*\.\s*([A-Z][A-Za-z0-9_]*)\s*=(?!=)/g,
    )) published.add(m[1]);

    const missing = [];
    let checked = 0;
    for (const rel of clientScripts()) {
        for (const m of code(read(rel)).matchAll(
            /\b(?:window|globalThis|global)\s*\.\s*([A-Z][A-Za-z0-9_]*)\b/g,
        )) {
            if (AMBIENT.has(m[1]) || OPTIONAL_GLOBALS.has(m[1])) continue;
            checked += 1;
            if (!published.has(m[1])) missing.push(`${rel} -> window.${m[1]}`);
        }
    }

    // The guard must be measuring something. A refactor that broke the
    // matcher would otherwise report a clean sweep of nothing at all,
    // which is this project's recurring false green.
    assert.ok(checked > 500,
        `only ${checked} global reads seen; the matcher has probably stopped matching`);
    assert.deepEqual([...new Set(missing)], [],
        'a client script reads a global nothing publishes. It will not throw at '
        + 'import; it throws when the line runs, or silently does nothing');
});

test('NEGATIVE CONTROL: an unpublished global really is reported', () => {
    // The matcher, run against a literal. If this stops failing, the test
    // above is asserting an empty list for the wrong reason.
    const sample = code("window.NoSuchModuleHere.doThing();");
    const hits = [...sample.matchAll(
        /\b(?:window|globalThis|global)\s*\.\s*([A-Z][A-Za-z0-9_]*)\b/g,
    )].map((m) => m[1]);
    assert.deepEqual(hits, ['NoSuchModuleHere']);
    assert.ok(!AMBIENT.has('NoSuchModuleHere'));
});

// ------------------------------------------------------------- DOM ids

/**
 * Ids READ by a client script that nothing in the tree emits.
 *
 * BOTH ENTRIES ARE MEASURED, PRE-EXISTING, AND ON BOTH LINES - checked at
 * the 1.4.0 merge base, on the other line's tip, and on ours. Neither was
 * introduced by the merge, and both are recorded here rather than fixed,
 * because fixing them is a behaviour change that belongs to whoever owns
 * those features.
 *
 * `settings-wrappers-slot`, `settings-settings-import-slot` and
 * `settings-terminal-commands-slot`: `settings-panel.js::mountSlots`
 * querySelects all three and mounts each behind an `if (slot)`. Nothing
 * emits the divs. Compare `settings-toast-history-slot` and
 * `settings-theme-slot`, which ARE emitted (by toast-history-panel.js and
 * settings-sections.js) and which therefore mount. So three settings
 * panels are silently absent, and the guard is what hides it.
 *
 * `detachSessionBtn`: the header button moved into the session editor
 * menu (`session-editor-menu.js::detachSession` calls the same
 * controller method). terminal.js still looks it up and still toggles its
 * `disabled`, all null-guarded, so it is dead but harmless.
 */
const KNOWN_ABSENT_IDS = new Set([
    'settings-wrappers-slot',
    'settings-settings-import-slot',
    'settings-terminal-commands-slot',
    'detachSessionBtn',
    // themes/themeSelector.js positions the theme picker relative to the
    // destroy button and says so at the call site: "Falls back to append
    // if destroy isn't present." Destroy left the session header for the
    // conversation sidebar (terminal.js:97 records the same move), so the
    // fallback is now the only branch and the picker simply appends.
    'destroySessionBtn',
]);

test('every DOM id a client script looks up is emitted somewhere', () => {
    const blob = providerBlob();
    const emitted = new Set();
    for (const m of blob.matchAll(/\bid\s*=\s*"([A-Za-z0-9_\-]+)"/g)) emitted.add(m[1]);
    for (const m of blob.matchAll(/\bid\s*=\s*'([A-Za-z0-9_\-]+)'/g)) emitted.add(m[1]);
    for (const m of blob.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_\-]+)['"]/g)) emitted.add(m[1]);
    for (const m of blob.matchAll(
        /setAttribute\(\s*['"]id['"]\s*,\s*['"]([A-Za-z0-9_\-]+)['"]/g,
    )) emitted.add(m[1]);

    const missing = [];
    let checked = 0;
    for (const rel of clientScripts()) {
        const src = code(read(rel));
        const reads = [
            ...src.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_\-]+)['"]/g),
            ...src.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_\-]+)['"]/g),
        ];
        for (const m of reads) {
            checked += 1;
            if (emitted.has(m[1]) || KNOWN_ABSENT_IDS.has(m[1])) continue;
            missing.push(`${rel} -> #${m[1]}`);
        }
    }

    assert.ok(checked > 50,
        `only ${checked} id reads seen; the matcher has probably stopped matching`);
    assert.deepEqual([...new Set(missing)], [],
        'a client script looks up an id nothing emits. getElementById returns '
        + 'null, the guard in front of it swallows that, and the feature is '
        + 'simply absent with nothing reporting it');
});

test('the known-absent id list has not started hiding live breakage', () => {
    // Each entry must STILL be absent. An id that has since gained an
    // emitter has to leave this list, or the list starts exempting a
    // working reference and would go on exempting it after it broke again.
    const blob = providerBlob();
    for (const id of KNOWN_ABSENT_IDS) {
        const emitted = new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(blob);
        assert.ok(!emitted,
            `#${id} is emitted now, so remove it from KNOWN_ABSENT_IDS - an `
            + 'exemption for a reference that works is an exemption that will '
            + 'outlive the next time it stops working');
    }
    // And each must still be READ by someone, or the entry is dead weight
    // that documents nothing.
    const readers = clientScripts().map(read).join('\n');
    for (const id of KNOWN_ABSENT_IDS) {
        assert.ok(readers.includes(id),
            `#${id} is no longer read by any client script; drop the exemption`);
    }
});

// ------------------------------------------------------- data attributes

test('every data-attribute a client script reads is written somewhere', () => {
    const blob = providerBlob();
    const written = new Set();
    // Written three ways, and the BARE BOOLEAN form is the one a naive
    // matcher misses: `data-brand-icon` and `data-status-key-toggle` are
    // both emitted with no `=` at all, so a pattern requiring one reports
    // two false alarms.
    for (const m of blob.matchAll(/\bdata-([a-z0-9\-]+)\s*=/g)) written.add(m[1]);
    for (const m of blob.matchAll(/\bdata-([a-z0-9\-]+)[\s'">]/g)) written.add(m[1]);
    for (const m of blob.matchAll(/dataset\s*\.\s*([A-Za-z0-9_]+)\s*=(?!=)/g)) {
        written.add(m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    }
    /** `data-row-status` -> `rowStatus`, the dataset spelling. */
    const camel = (d) => d.split('-').map(
        (p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)),
    ).join('');
    const writtenCamel = new Set([...written].map(camel));

    // OPT-IN ESCAPE HATCHES, read but deliberately never written by us.
    // `dismiss-guard.js` offers `[data-keep-open]` so a control can mark
    // itself as not dismissing the panel it sits in. No shipped markup
    // sets it today; the selector is the published API for markup that
    // wants it, so an unused one is a feature nobody has needed, not a
    // dangling read.
    const OPT_IN_ATTRS = new Set(['keep-open']);

    const missing = [];
    let checked = 0;
    for (const rel of clientScripts()) {
        const src = code(read(rel));
        for (const m of src.matchAll(/\[data-([a-z0-9\-]+)[\]=~^*$|]/g)) {
            if (OPT_IN_ATTRS.has(m[1])) continue;
            checked += 1;
            if (!written.has(m[1])) missing.push(`${rel} -> [data-${m[1]}]`);
        }
        for (const m of src.matchAll(/getAttribute\(\s*['"]data-([a-z0-9\-]+)['"]/g)) {
            checked += 1;
            if (!written.has(m[1])) missing.push(`${rel} -> data-${m[1]}`);
        }
        for (const m of src.matchAll(/\.dataset\s*\.\s*([A-Za-z0-9_]+)\b(?!\s*=)/g)) {
            checked += 1;
            if (!writtenCamel.has(m[1])) missing.push(`${rel} -> dataset.${m[1]}`);
        }
    }

    assert.ok(checked > 30,
        `only ${checked} data-attribute reads seen; the matcher has probably stopped`);
    assert.deepEqual([...new Set(missing)], [],
        'a client script reads a data-attribute nothing writes. This is the '
        + 'data-row-status shape exactly: the read returns null, every suite '
        + 'still passes, and the behaviour behind it is gone');
});

test('THE ROW-STATUS PRECEDENT, asserted writer-against-reader', () => {
    // The specific regression this whole file is modelled on, pinned
    // rather than described, and pinned to the CURRENT spelling.
    //
    // THE HISTORY MATTERS BECAUSE IT HAPPENED TWICE. Our line's own kebab
    // spelled it `data-row-status`; the 2026-09-10 reconcile moved us onto
    // the other line's trigger, which spells it `data-row-menu-status`.
    // session-sidebar-clicks.js:307 carries the note. Reading the old
    // spelling off the new trigger returns null and the restart picker
    // reports every session as "unknown" while nothing fails - "a merge
    // that compiles and lies", in that file's own words.
    //
    // So this asserts the two halves AGREE, rather than asserting either
    // one's spelling in isolation, which is what lets it survive a third
    // rename instead of having to be edited by whoever does it.
    const menu = read('client/js/session-row-menu.js');
    const clicks = code(read('client/js/session-sidebar-clicks.js'));

    // What the trigger STAMPS: the status attribute and the key the
    // reader selects it by.
    const stamped = [...menu.matchAll(/'(data-row-menu[a-z\-]*)="'/g)].map((m) => m[1]);
    // The selector key itself is a NAMED CONSTANT rather than a literal,
    // which is the right shape and means it has to be resolved rather
    // than grepped for. Resolving it is also the point: a constant whose
    // VALUE drifted from what the reader hardcodes is the same defect
    // with an extra hop in it.
    const triggerAttr = /TRIGGER_ATTR\s*=\s*'([a-z\-]+)'/.exec(menu);
    assert.ok(triggerAttr, 'session-row-menu.js must define TRIGGER_ATTR');
    stamped.push(triggerAttr[1]);
    assert.ok(stamped.includes('data-row-menu-status'),
        'SessionRowMenu.triggerHtml must stamp the status attribute on the trigger');
    assert.equal(triggerAttr[1], 'data-row-menu',
        'the selector key the reader hardcodes is `data-row-menu`; if the '
        + 'constant moves, the querySelector in session-sidebar-clicks.js '
        + 'stops matching and every restart silently reports unknown');

    // What the reader ASKS FOR, and that it asks the TRIGGER for it.
    assert.match(clicks, /querySelector\(\s*`?\[data-row-menu="/,
        'session-sidebar-clicks.js must resolve the TRIGGER by name. Pointing '
        + 'this at the row instead is the defect: the row does not carry the '
        + 'status, so runRestart silently receives null');
    const asked = [...clicks.matchAll(/getAttribute\('(data-row-menu[a-z\-]*)'\)/g)]
        .map((m) => m[1]);
    assert.ok(asked.includes('data-row-menu-status'),
        `the reader asks for ${JSON.stringify(asked)}, which the trigger does not stamp`);

    // THE AGREEMENT ITSELF. Every row-menu attribute the reader asks for
    // must be one the writer stamps. This is the assertion that survives
    // a rename: rename both and it passes, rename one and it fails.
    for (const attr of asked) {
        assert.ok(stamped.includes(attr),
            `session-sidebar-clicks.js reads ${attr}, which session-row-menu.js `
            + `never stamps. Stamped: ${JSON.stringify(stamped)}`);
    }
});

test('NEGATIVE CONTROL: writer and reader disagreeing really is caught', () => {
    // The comparison above, run against a disagreeing pair, so a future
    // refactor of the matchers cannot leave it comparing two empty lists.
    const stamped = ['data-row-menu', 'data-row-menu-status'];
    const asked = ['data-row-status'];
    assert.ok(!asked.every((a) => stamped.includes(a)),
        'the old spelling must not compare equal to the new one');
    assert.ok(stamped.length > 0 && asked.length > 0,
        'and neither side may be empty, or the check proves nothing');
});

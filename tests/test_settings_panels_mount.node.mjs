/**
 * EVERY SETTINGS PANEL ACTUALLY MOUNTS.
 * ---------------------------------------------------------------------
 * WHY THIS FILE EXISTS, and it is not the reason you would guess. A
 * review reported that three `settings-*-slot` ids were QUERIED by
 * client/js/settings-panel.js and EMITTED BY NOTHING, so three panels
 * could never appear: wrappers, terminal commands and settings import.
 *
 * THAT WAS A FALSE ALARM, and the way it was produced is worth keeping.
 * The ids are composed at runtime -
 *
 *     parts.push('<div id="settings-' + slot + '-slot"></div>');
 *
 * - so a literal grep for `settings-wrappers-slot` finds the
 * `querySelector` and never the emitter. The two slots that DID appear
 * to have an emitter (theme, toast history) are simply the two written
 * as literals by their own render functions. Driven in a real browser,
 * all five slots exist and all five carry a mounted child.
 *
 * So the defect was in the METHOD, and this is the test that answers the
 * question the grep could not. A test asserting "these ids are queried",
 * or "the source contains this string", is worth nothing here - that is
 * precisely what produced the wrong answer. This one RUNS the real
 * panel: it loads settings-panel.js with the real settings-tabs.js and
 * settings-sections.js beside it, opens the panel, and records which
 * panels were handed a slot. A slot the markup does not declare hands
 * back null and its panel is never mounted, which is the real failure
 * mode and is exactly what the negative control below produces.
 *
 * IT IS DERIVED, NOT LISTED. The expected set comes from the module's
 * own TABS table, read out of the source, so adding a tab with a new
 * slot and forgetting to emit it fails here rather than passing because
 * nobody updated a hardcoded list.
 *
 * Run with: node tests/test_settings_panels_mount.node.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let passes = 0;
let failures = 0;

/**
 * Run one named check.
 *
 * @param {string} name - what is being asserted.
 * @param {Function} fn - the body; throwing or rejecting fails it.
 * @returns {Promise<void>}
 */
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

const CLIENT_JS = path.join(repoRoot, 'client', 'js');
const PANEL = path.join(CLIENT_JS, 'settings-panel.js');

/**
 * A DOM stand-in sized to what `settings-panel.js` touches.
 *
 * `innerHTML` is a STRING, as it is in the real thing, and
 * `querySelector('#x')` answers by asking whether that string actually
 * declares `id="x"`. That is the whole question under test: does the
 * markup the panel BUILT contain the id the panel LOOKS UP. A double
 * that returned an element for every selector would make this file pass
 * against a panel that emits nothing at all.
 *
 * @param {string} tag - element tag name.
 * @returns {object} the stand-in element.
 */
function makeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        innerHTML: '',
        className: '',
        children: [],
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = String(value); },
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i !== -1) this.children.splice(i, 1);
            return child;
        },
        addEventListener() {},
        focus() {},
        querySelectorAll() { return []; },
    };
    el.querySelector = function (selector) {
        const sel = String(selector || '');
        if (!sel.startsWith('#')) return null;
        const id = sel.slice(1);
        // The element's own markup must DECLARE the id, exactly as a
        // browser would require before it could hand one back.
        if (this.innerHTML.includes(`id="${id}"`)) {
            const found = makeEl('div');
            found.attrs.id = id;
            return found;
        }
        return null;
    };
    return el;
}

/**
 * Load the settings panel with recorders on every bespoke panel.
 *
 * The REAL settings-tabs.js and settings-sections.js are loaded, not
 * stubbed: both are pure string builders and they are half of what
 * produces the markup the lookups run against. Only the leaf panels are
 * recorders, because what is under test is whether each was HANDED a
 * slot, not what it then draws.
 *
 * @param {string} panelSource - the module text to run.
 * @returns {object} `{sandbox, mounted, open}`.
 */
function standUp(panelSource) {
    /** panel name -> the slot element it was mounted into. */
    const mounted = new Map();

    const sandbox = { console: { log() {}, warn() {}, error() {} } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const body = makeEl('body');
    sandbox.document = {
        body,
        activeElement: null,
        createElement: (tag) => makeEl(tag),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
    };
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;

    // The real pure builders.
    for (const file of ['settings-sections.js', 'settings-tabs.js']) {
        const full = path.join(CLIENT_JS, file);
        vm.runInContext(fs.readFileSync(full, 'utf8'), vm.createContext(sandbox), { filename: full });
    }
    // Tab wiring needs a real DOM and is not what this asks about.
    sandbox.SettingsTabs.wire = () => {};
    sandbox.SettingsTabs.activate = () => {};

    const record = (name) => ({ mount: (slot) => { mounted.set(name, slot); } });
    sandbox.ThemeSelector = record('theme');
    sandbox.AgentWrappersPanel = record('wrappers');
    sandbox.ToastHistoryPanel = record('toast-history');
    sandbox.SettingsImport = record('settings-import');
    sandbox.TerminalCommandsPanel = {
        mount: (slot) => { mounted.set('terminal-commands', slot); },
    };
    sandbox.SettingsWorkspace = {
        render: () => '<section data-settings-section="workspace"></section>',
        wire() {}, collect: () => ({}), showWarnings() {},
    };
    sandbox.SettingsAudio = { render: () => '<section data-settings-section="audio"></section>', wire() {} };

    sandbox.API = {
        getSettings: async () => ({
            agents: {}, notifications: {}, server: {},
            terminal_commands: null, workspace: {}, server_prefs: {},
        }),
    };

    vm.runInContext(panelSource, vm.createContext(sandbox), { filename: PANEL });
    return { sandbox, mounted, body };
}

/**
 * Every bespoke slot name the module's own TABS table declares.
 *
 * Read out of the source so the expectation cannot drift from the code,
 * and filtered to the ones that go down the generic
 * `<div id="settings-X-slot">` path - `appearance`, `audio`, `server`
 * and `workspace` are rendered by their own functions instead.
 *
 * @returns {string[]} slot names, e.g. ['wrappers', 'terminal-commands'].
 */
function declaredSlots() {
    const src = fs.readFileSync(PANEL, 'utf8');
    const tabs = /var TABS = \[([\s\S]*?)\n    \];/.exec(src);
    assert.ok(tabs, 'could not find the TABS table in settings-panel.js');
    const names = new Set();
    const re = /slots:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(tabs[1])) !== null) {
        for (const raw of m[1].split(',')) {
            const name = raw.trim().replace(/^'|'$/g, '');
            if (name) names.add(name);
        }
    }
    assert.ok(names.size >= 5, `only found ${names.size} slots in TABS`);
    const bespoke = [...names].filter((n) => !['appearance', 'audio', 'server', 'workspace'].includes(n));
    // The theme picker is a bespoke mount too, into a literal id emitted
    // by renderAppearanceSection, so it is added back explicitly.
    return bespoke.concat(['theme']);
}

// ---------------------------------------------------------------------

await test('opening settings mounts every bespoke panel into a real slot', async () => {
    const env = standUp(fs.readFileSync(PANEL, 'utf8'));
    await env.sandbox.SettingsPanel.open(null);

    const expected = declaredSlots().sort();
    const got = [...env.mounted.keys()].sort();
    assert.deepEqual(
        got, expected,
        `panels that never mounted: ${expected.filter((n) => !got.includes(n)).join(', ') || '(none)'}`,
    );
    for (const [name, slot] of env.mounted) {
        assert.ok(slot, `${name} was mounted into a null slot`);
        assert.equal(slot.attrs.id.endsWith('-slot'), true, `${name} got a non-slot element`);
    }
});

await test('the three reported as dead are among them: wrappers, terminal commands, import', async () => {
    // The specific claim that was made. Named rather than counted so it
    // cannot pass because some other panel happened to mount.
    const env = standUp(fs.readFileSync(PANEL, 'utf8'));
    await env.sandbox.SettingsPanel.open(null);
    for (const name of ['wrappers', 'terminal-commands', 'settings-import']) {
        assert.ok(env.mounted.has(name), `${name} did not mount`);
    }
    assert.equal(env.mounted.get('wrappers').attrs.id, 'settings-wrappers-slot');
    assert.equal(env.mounted.get('terminal-commands').attrs.id, 'settings-terminal-commands-slot');
    assert.equal(env.mounted.get('settings-import').attrs.id, 'settings-settings-import-slot');
});

await test('the slot ids are BUILT, not written, which is why the grep missed them', () => {
    // Records the mechanism so the next reader does not repeat the
    // measurement. If this ever becomes false the grep would work again
    // and this file is still the one that answers the real question.
    const src = fs.readFileSync(PANEL, 'utf8');
    assert.match(
        src, /'<div id="settings-' \+ slot \+ '-slot"><\/div>'/,
        'the slot markup is no longer composed at runtime; re-check the claim above',
    );
});

// ---------------------------------------------------------------------
// NEGATIVE CONTROLS. Without these, a harness that recorded a mount for
// everything would pass every check above.
// ---------------------------------------------------------------------

await test('NEGATIVE CONTROL: a slot the markup does not declare never mounts', async () => {
    const real = fs.readFileSync(PANEL, 'utf8');
    // Break the EMITTER only, exactly the defect that was reported:
    // the lookup stays, the markup stops declaring the id.
    const broken = real.replace(
        `'<div id="settings-' + slot + '-slot"></div>'`,
        `'<div id="settings-' + slot + '-SLOTTYPO"></div>'`,
    );
    assert.notEqual(broken, real, 'nothing was broken, so this control reproduces nothing');

    const env = standUp(broken);
    await env.sandbox.SettingsPanel.open(null);

    for (const name of ['wrappers', 'terminal-commands', 'settings-import', 'toast-history']) {
        assert.ok(!env.mounted.has(name), `${name} mounted despite its slot being absent`);
    }
    // The theme slot is written as a literal by renderAppearanceSection,
    // so it is unaffected - which is itself the proof that the harness
    // is reading real markup rather than answering yes to everything.
    assert.ok(env.mounted.has('theme'), 'the literal-id slot stopped mounting too: the harness is wrong');
});

await test('NEGATIVE CONTROL: a panel global that is absent is simply not mounted', async () => {
    const env = standUp(fs.readFileSync(PANEL, 'utf8'));
    env.sandbox.AgentWrappersPanel = undefined;
    await env.sandbox.SettingsPanel.open(null);
    assert.ok(!env.mounted.has('wrappers'), 'a mount was recorded for a panel that does not exist');
    assert.ok(env.mounted.has('terminal-commands'), 'the other panels stopped mounting too');
});

// ---------------------------------------------------------------------
// The two dead-but-guarded reads that were reported alongside.
// ---------------------------------------------------------------------

/**
 * Strip comments, so a file may NAME a control it no longer reaches for.
 *
 * @param {string} src - file text.
 * @returns {string} the code, comments blanked.
 */
function codeOnly(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

await test('destroySessionBtn is gone from the markup AND from the code that looked for it', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'client', 'index.html'), 'utf8');
    assert.ok(!html.includes('destroySessionBtn'), 'the button is back in the markup');
    const theme = codeOnly(fs.readFileSync(path.join(CLIENT_JS, 'themes', 'themeSelector.js'), 'utf8'));
    assert.ok(
        !theme.includes('destroySessionBtn'),
        'themeSelector.js still positions itself against a button that has not existed for releases',
    );
});

await test('detachSessionBtn is absent from the markup, and its reads stay guarded', () => {
    // DELIBERATELY NOT REMOVED. The behaviour moved to the session editor
    // menu's "detach session" row (client/js/session-editor-menu.js), and
    // every read in terminal.js is `if (this.detachSessionBtn)`. Deleting
    // seven touch points from a 2600-line hot file buys nothing a user
    // can see. What this pins is that it stays HARMLESS: if the id ever
    // returns to the markup, two controls would fight over one action.
    const html = fs.readFileSync(path.join(repoRoot, 'client', 'index.html'), 'utf8');
    assert.ok(!html.includes('id="detachSessionBtn"'), 'the button is back in the markup');
    const term = fs.readFileSync(path.join(CLIENT_JS, 'terminal.js'), 'utf8');
    const lines = codeOnly(term).split('\n');
    const reads = lines.filter((l) => l.includes('this.detachSessionBtn')).length;
    assert.ok(reads > 0, 'the reads are gone; delete this check with them');
    // A dereference is safe when this line, or one of the two above it,
    // tests the element first. That is how every one of them is written.
    const unguarded = lines.filter((line, i) => {
        if (!/this\.detachSessionBtn\s*\./.test(line)) return false;
        const window3 = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
        return !/if\s*\(\s*this\.detachSessionBtn\s*\)/.test(window3);
    });
    assert.deepEqual(
        unguarded, [],
        'an unguarded dereference would throw once the element is really gone',
    );
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');

// The session search panel is in the COMPILED tree, and this is the
// check that the shipped artifact says so.
//
// WHY A NODE SUITE AT ALL, when the panel's behaviour is measured in
// web/src/lib/terminal-search/*.test.ts. Those run against the SOURCE,
// through vitest, with the Svelte compiler in the loop. This one runs
// against `client/dist/app.js`, the file that is committed and deployed,
// in a vm sandbox with no DOM - which is what proves three separate
// things a source test cannot:
//
//   1. the three entry points survive the bundle and the minifier and
//      are reachable at `window.CloudeWeb`,
//   2. evaluating the bundle on a page with no terminal screen mounts
//      nothing and throws nothing, which is every page the launchpad
//      harnesses build,
//   3. `client/index.html` stopped loading the four deleted files and
//      still loads the three that stayed vanilla.
//
// The precedent is tests/test_session_row_menu_superset.node.mjs and the
// helper it shares: load the real artifact, never a stub, because a stub
// agrees with whatever it was built to agree with.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

import { installCloudeWeb } from './helpers/cloude-web-sandbox.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Description: a sandbox holding the bundle, with the smallest document
 *   that answers the one question the mount asks. `getElementById`
 *   answering null is the state of every page that is not this app's
 *   own shell.
 * Inputs: none. Output: object - the published window.CloudeWeb.
 */
function loadBundle() {
    const context = vm.createContext({
        console,
        document: {
            getElementById: () => null,
            querySelector: () => null,
            addEventListener: () => {},
            removeEventListener: () => {},
        },
    });
    return installCloudeWeb(context);
}

test('the bundle publishes the three session-search entry points', () => {
    const web = loadBundle();
    for (const name of [
        'mountTerminalSearch',
        'openTerminalSearch',
        'toggleTerminalSearch',
        'terminalSearchIsOpen',
        'unmountTerminalSearch',
    ]) {
        assert.equal(typeof web[name], 'function', `CloudeWeb.${name} must be a function`);
    }
});

test('on a page with no terminal container the mount is a silent no-op', () => {
    // The bundle already ran `mountTerminalSearch()` at evaluation time.
    // Reaching this line at all is half the assertion; the rest is that
    // asking again still refuses rather than throwing.
    const web = loadBundle();
    assert.equal(web.mountTerminalSearch(), null);
    assert.equal(web.terminalSearchIsOpen(), false);
    // And the two convenience entry points must not throw on a page that
    // cannot mount: the terminal tools menu calls one of them.
    assert.doesNotThrow(() => web.openTerminalSearch());
    assert.doesNotThrow(() => web.toggleTerminalSearch());
});

test('index.html no longer loads the four files the port deleted', () => {
    const html = read('client/index.html');
    for (const gone of [
        'terminal-search.js',
        'terminal-search-chrome.js',
        'terminal-search-keys.js',
        'terminal-prompt-rail.js',
        'terminal-search.css',
    ]) {
        assert.ok(
            !html.includes(`/static/js/${gone}`) && !html.includes(`/static/css/${gone}`),
            `${gone} is still loaded by client/index.html`,
        );
        assert.ok(
            !fs.existsSync(path.join(ROOT, 'client', 'js', gone)),
            `client/js/${gone} should have been deleted with its script tag`,
        );
    }
});

test('the three framework-free modules and the add-on are still loaded', () => {
    // The panel calls all four through `window` at USE time. A missing
    // tag here costs a feature and says nothing in the console.
    const html = read('client/index.html');
    for (const kept of [
        '/static/js/terminal-prompt-scan.js',
        '/static/js/terminal-history-load.js',
        '/static/js/terminal-search-engine.js',
        '/static/js/terminal-search-deep-dive.js',
        '/static/vendor/xterm/xterm-addon-search.js',
    ]) {
        assert.ok(html.includes(kept), `${kept} must still be loaded`);
    }
});

test('the terminal container carries the id the one mount path addresses', () => {
    // web/src/lib/mount.ts looks a container up by id and by nothing
    // else, so this attribute is the whole seam.
    const html = read('client/index.html');
    assert.match(html, /class="terminal-container" id="terminal-container"/);
});

test('the header button is still there, still wired in JS and not in markup', () => {
    const html = read('client/index.html');
    const at = html.indexOf('id="terminalSearchBtn"');
    assert.ok(at > -1, 'the header button must exist in the shell');
    const tag = html.slice(html.lastIndexOf('<button', at), html.indexOf('>', at) + 1);
    assert.ok(
        !/onclick/.test(tag),
        'src/main.py stamps script-src self; an inline handler is silently dead',
    );
    assert.match(tag, /aria-label="search session"/);
    assert.match(tag, /title="search \(Cmd\+F\)"/, 'the hotkey must be advertised');
    assert.match(tag, /class="btn-icon"/, 'the box comes from the header, not from us');
});

test('the tools menu reaches the panel through the namespace, guarded', () => {
    // The row is built by a CLASSIC script that loads before the module
    // bundle, so an unguarded read would throw in that window.
    const src = read('client/js/terminal-tools-menu.js');
    assert.match(src, /typeof web\.openTerminalSearch === 'function'/);
    assert.ok(
        !src.includes('window.TerminalSearch'),
        'window.TerminalSearch no longer exists; the row must not reach for it',
    );
});

test('the emitted stylesheet still carries the rules the panel cannot scope', () => {
    // Two of this feature's rules are about elements the component does
    // not render: the decoration colours the engine reads off
    // .terminal-container, and the header trigger's own visibility. They
    // are `:global` in SearchPanel.svelte, so they only exist if the
    // build kept them.
    const css = read('client/dist/app.css');
    assert.ok(css.includes('--terminal-search-match-bg:'), 'the decoration colours must ship');
    assert.ok(css.includes('#terminalSearchBtn'), 'the header trigger scoping must ship');
    assert.match(
        css,
        /\.terminal-prompt-rail\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/,
        'the rail hides with el.hidden, and [hidden] in the UA sheet loses to any author display',
    );
});

test('every file the port added stays under the 500-line budget', () => {
    const dir = path.join(ROOT, 'web', 'src', 'lib', 'terminal-search');
    for (const name of fs.readdirSync(dir)) {
        const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').length;
        assert.ok(lines <= 500, `${name} is ${lines} lines, over the 500 budget`);
    }
});

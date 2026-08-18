// feat/db-is-authoritative - the project list's provenance banner, in
// rendered DOM.
//
// Split from tests/test_project_authority_render.node.mjs to keep both
// files inside this project's 500-line rule. That file covers the
// duplicate-root fix; this one covers the four states the banner can be
// in and the fact that they are never rendered the same way.
//
// THE RULE THIS FILE ENFORCES. Three of the four states are "something
// is not normal", and the fourth is "the check itself did not answer".
// None of them may render as the healthy case, and the healthy case must
// render NOTHING - a banner that is always on screen is furniture and
// stops being read.
//
// Geometry for the fallback banner, measured live in Chromium against
// tests/manual/project-authority-geometry-harness.html?fixture=fallback,
// 2026-08-18, ACTUAL viewport 1178x856 (resize_window silently no-opped
// on a requested 430x900 - the reported viewport is the real one),
// document.hidden=true with innerWidth asserted 1178 before any rect was
// read:
//   .project-authority-banner-fallback
//     state "config_fallback", writable "false"
//     height 66.9375, width 800, top 94, visible true
// It occupies a real box. It is not a zero-height element that
// technically exists and shows the user nothing.
//
// Run with: node tests/test_project_authority_banner.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name - Test description.
 * @param {() => void} fn - Body; throwing marks it failed.
 * @returns {void}
 */
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

// His real config.json project list, verified 2026-08-18 against a
// read-only copy of the live file. Held verbatim, duplicates included -
// approximating it would test a shape that is not his.
const REAL_CONFIG = [
    { name: 'fs2', path: '/Users/jsugamele/Development/scrolltest' },
    { name: 'scrolltest', path: '/Users/jsugamele/Development/scrolltest' },
    { name: 'test pause', path: '/Users/jsugamele/Development/ses_ec5bf2a3' },
    { name: 'ses_ec5bf2a3', path: '/Users/jsugamele/Development/ses_ec5bf2a3' },
    { name: 'asd', path: '/Users/jsugamele/Development/ses_8704e610' },
    { name: 'qqwe', path: '/Users/jsugamele/Development/ses_ec5bf2a3' },
    { name: 'Test', path: '/Users/jsugamele/Development/ses_c3737fbe' },
    { name: 'console-msw4z3m5', path: '/Users/jsugamele' },
    { name: 'claude-config-sync-2', path: '/Users/jsugamele/Development/claude-config-sync' },
    { name: 'claude-config-sync', path: '/Users/jsugamele/Development/claude-config-sync' },
    { name: 'CloudeCode', path: '/Users/jsugamele/Development/CloudeCode' },
    { name: 'Development', path: '/Users/jsugamele/Development' },
    { name: 'ai-setup', path: '/Users/jsugamele/Development/ai-setup' },
];

const TRIPLICATED_ROOT = '/Users/jsugamele/Development/ses_ec5bf2a3';

/**
 * What GET /projects now returns for his config: one row per unique root,
 * first config name wins, each carrying its database row id.
 * @returns {object[]} Project rows in launcher order.
 */
function authoritativeProjects() {
    const seen = new Map();
    let nextId = 1;
    for (const entry of REAL_CONFIG) {
        if (seen.has(entry.path)) continue;
        seen.set(entry.path, {
            id: nextId++,
            name: entry.name,
            path: entry.path,
            root: entry.path,
            description: null,
            agent_type: null,
        });
    }
    return [...seen.values()];
}

/**
 * What GET /projects returned BEFORE this change: one entry per config
 * row, no id. Used to prove the old shape really did draw 13 nodes, so
 * the fixed count is a measured improvement and not a tautology.
 * @returns {object[]} Project rows, duplicates included.
 */
function legacyConfigProjects() {
    return REAL_CONFIG.map((e) => ({
        name: e.name,
        path: e.path,
        description: null,
    }));
}

/**
 * Build one stub element whose innerHTML is a plain string the renderer
 * writes into, so assertions read the actual rendered markup.
 * @param {string} id - Element id, for getElementById lookup.
 * @returns {object} Stub element.
 */
function makeEl(id) {
    return {
        id,
        innerHTML: '',
        textContent: '',
        style: {},
        dataset: {},
        _attrs: {},
        setAttribute(name, value) { this._attrs[name] = String(value); },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this._attrs, name)
                ? this._attrs[name] : null;
        },
        addEventListener() {},
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
}

/**
 * Load launchpad.js in a vm sandbox, arrange the given state, and call
 * renderProjectList() once.
 * @param {{projects: object[], presence?: object[], authority?: object|null,
 *   runningSessions?: object[], attribution?: object[]}} fixture
 * @returns {string} The HTML renderProjectList() wrote.
 */
function renderWith(fixture) {
    const projectList = makeEl('project-list');
    const byId = { 'project-list': projectList };
    const fakeDocument = {
        getElementById(id) { return byId[id] || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        createElement() { return makeEl('created'); },
    };
    const fakeWindow = {
        API: {},
        SessionStatusUI: {
            dotHtml() { return '<span class="status-dot"></span>'; },
            pencilIconSvg() { return '<svg class="pencil"></svg>'; },
            trashIconSvg() { return '<svg class="trash"></svg>'; },
        },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        addEventListener() {},
        dispatchEvent() {},
        CustomEvent: function CustomEvent(type, opts) {
            this.type = type;
            this.detail = opts && opts.detail;
        },
        requestAnimationFrame(cb) { cb(); },
        matchMedia() { return { matches: false, addEventListener() {} }; },
    };
    fakeWindow.window = fakeWindow;
    const context = {
        window: fakeWindow,
        document: fakeDocument,
        console: { log() {}, warn() {}, error() {}, debug() {} },
        localStorage: fakeWindow.localStorage,
        requestAnimationFrame: fakeWindow.requestAnimationFrame,
        CustomEvent: fakeWindow.CustomEvent,
        setInterval() { return 0; },
        clearInterval() {},
        setTimeout() { return 0; },
        clearTimeout() {},
        alert() {},
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'launchpad.js'), 'utf8'),
        context,
        { filename: 'launchpad.js' }
    );
    const lp = context.window.Launchpad;
    lp.projects = fixture.projects;
    lp.projectPresence = new Map();
    for (const row of (fixture.presence || [])) {
        lp.projectPresence.set(row.raw_path, row);
        if (row.root) lp.projectPresence.set(row.root, row);
    }
    lp.projectAuthority = fixture.authority === undefined
        ? healthyAuthority()
        : fixture.authority;
    lp.runningSessions = fixture.runningSessions || [];
    lp.sessionAttribution = new Map(
        (fixture.attribution || []).map((r) => [r.tmux_name, r])
    );
    lp.sessionAttributionListingOk = true;
    lp.sessionAttributionListingDetail = null;
    lp.renderProjectList();
    return projectList.innerHTML;
}

/**
 * The healthy authority payload: db mode, sources agree.
 * @returns {object} An authority block.
 */
function healthyAuthority() {
    return {
        mode: 'db',
        writable: true,
        degraded: false,
        message: 'projects are served from cloude.db, which is authoritative.',
        detail: null,
        project_count: 9,
        diff: {
            agree: true, authoritative: 'db', difference_count: 0,
            only_in_db: [], only_in_config: [], field_mismatches: [],
            duplicate_config_roots: [],
        },
        diff_state: 'known',
    };
}

/**
 * Count non-overlapping occurrences of a literal substring.
 * @param {string} haystack - Text to search.
 * @param {string} needle - Literal to count.
 * @returns {number} Occurrence count.
 */
function countOf(haystack, needle) {
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i !== -1) {
        n++;
        i = haystack.indexOf(needle, i + needle.length);
    }
    return n;
}

/**
 * Count rendered `.project-node` elements (the real project rows, which
 * excludes the virtual "no project" and "needs attention" groups because
 * those carry the modifier classes `--virtual` / `--attention`).
 * @param {string} html - Rendered markup.
 * @returns {number} Node count.
 */
function projectNodeCount(html) {
    return countOf(html, '<div class="project-node" data-project-node="project"');
}

// --- the provenance banner's four states ---------------------------------

test('healthy db mode draws no banner at all', () => {
    const html = renderWith({ projects: authoritativeProjects() });
    assert.ok(!html.includes('project-authority-banner'));
});

test('a failed authority fetch renders CANNOT DETERMINE, never healthy', () => {
    const html = renderWith({ projects: authoritativeProjects(), authority: null });
    assert.ok(html.includes('project-authority-banner-unknown'));
    assert.ok(html.includes('data-authority-state="unknown"'));
    assert.ok(html.includes('CANNOT DETERMINE'));
});

test('config fallback renders a distinct banner and marks itself unwritable', () => {
    const html = renderWith({
        projects: authoritativeProjects(),
        authority: {
            mode: 'config_fallback',
            writable: false,
            degraded: true,
            message: 'cloude.db is UNREACHABLE. Projects are being served from config.json in read-only rollback mode.',
            detail: 'no such file',
            project_count: 9,
            diff: null,
            diff_state: 'cannot_determine',
        },
    });
    assert.ok(html.includes('project-authority-banner-fallback'));
    assert.ok(html.includes('data-authority-state="config_fallback"'));
    assert.ok(html.includes('data-writable="false"'));
    assert.ok(html.includes('UNREACHABLE'));
    // Still draws the projects - a degraded launcher is not a blank one.
    assert.equal(projectNodeCount(html), 9);
});

test('the three degraded banners are visually distinct classes', () => {
    const fallback = renderWith({
        projects: authoritativeProjects(),
        authority: {
            mode: 'config_fallback', writable: false, degraded: true,
            message: 'm', detail: null, project_count: 9,
            diff: null, diff_state: 'cannot_determine',
        },
    });
    const empty = renderWith({
        projects: authoritativeProjects(),
        authority: {
            mode: 'db_empty_config_has', writable: true, degraded: true,
            message: 'm', detail: null, project_count: 9,
            diff: { agree: true, authoritative: 'db', difference_count: 0,
                    only_in_db: [], only_in_config: [], field_mismatches: [],
                    duplicate_config_roots: [] },
            diff_state: 'known',
        },
    });
    const unknown = renderWith({ projects: authoritativeProjects(), authority: null });

    assert.ok(fallback.includes('project-authority-banner-fallback'));
    assert.ok(empty.includes('project-authority-banner-empty'));
    assert.ok(unknown.includes('project-authority-banner-unknown'));
    assert.ok(!empty.includes('project-authority-banner-fallback'));
    assert.ok(!unknown.includes('project-authority-banner-fallback'));
});

test('an empty database with a populated config does not say "no projects"', () => {
    const html = renderWith({
        projects: authoritativeProjects(),
        authority: {
            mode: 'db_empty_config_has', writable: true, degraded: true,
            message: 'cloude.db opened cleanly but holds no projects. This is NOT a claim that you have no projects.',
            detail: 'db_projects=0 config_projects=13', project_count: 9,
            diff: { agree: false, authoritative: 'db', difference_count: 9,
                    only_in_db: [], only_in_config: [], field_mismatches: [],
                    duplicate_config_roots: [] },
            diff_state: 'known',
        },
    });
    assert.ok(html.includes('NOT a claim'));
    assert.ok(!html.includes('no projects yet'));
});

test('a disagreement names both sides and states who is authoritative', () => {
    const html = renderWith({
        projects: authoritativeProjects(),
        authority: {
            mode: 'db', writable: true, degraded: false,
            message: 'ok', detail: null, project_count: 9,
            diff: {
                agree: false, authoritative: 'db', difference_count: 2,
                only_in_db: [{ root: '/tmp/x', display_name: 'db-only', raw_path: '/tmp/x' }],
                only_in_config: [{ root: '/tmp/y', name: 'config-only', path: '/tmp/y' }],
                field_mismatches: [], duplicate_config_roots: [],
            },
            diff_state: 'known',
        },
    });
    assert.ok(html.includes('project-authority-banner-disagree'));
    assert.ok(html.includes('DISAGREE'));
    assert.ok(html.includes('db-only'), 'the DB-only project must be named');
    assert.ok(html.includes('config-only'), 'the config-only project must be named');
    assert.ok(html.includes('cloude.db is authoritative'));
    assert.ok(html.includes('data-difference-count="2"'));
});

test('the empty-list state also carries the banner', () => {
    // An empty list is exactly when the user most needs to know whether
    // the datastore answered.
    const html = renderWith({ projects: [], authority: null });
    assert.ok(html.includes('project-authority-banner-unknown'));
    assert.ok(html.includes('no projects yet'));
});

test('the empty state no longer tells the user to edit config.json', () => {
    // config.json is a rollback artifact now, not the place to add a
    // project. Advice that was true before the inversion is a lie after it.
    const html = renderWith({ projects: [] });
    assert.ok(!html.includes('edit config.json'));
});

// --- the id plumbing -----------------------------------------------------

test('a project with a null id draws no children even if sessions claim id 0', () => {
    // The degraded fallback carries id: null. Rendering that as row 0
    // would let a session attributed to project 0 attach to every
    // config-sourced project at once.
    const projects = authoritativeProjects().map((p) => ({ ...p, id: null }));
    const html = renderWith({
        projects,
        authority: null,
        runningSessions: [{
            name: 'cloude_orphan', created_by_cloude: true, created_at_epoch: 1,
            window_count: 1, is_active: false, status: 'idle', unread: false,
        }],
        attribution: [{ tmux_name: 'cloude_orphan', project_id: 0, project_attribution: 'exact' }],
    });
    assert.equal(countOf(html, 'class="project-node__sessions"'), 0);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

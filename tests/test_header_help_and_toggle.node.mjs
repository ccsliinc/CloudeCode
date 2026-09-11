// Node test for fix/header-icons-and-menu: the help button's white square,
// its move beside the title, the home-screen sidebar toggle's placement,
// the rename affordance's three states, and folding open-from-folder into
// the new-claude-project flow.
//
// WHY THE ASSERTIONS ARE AGAINST THE SOURCE, like test_home_header_consolidation.node.mjs
// and test_home_bottom_bar.node.mjs already do: the bug class here is a MISSING
// or WRONG declaration, not a logic error a jsdom DOM would catch.
//
// AND WHY THAT IS NOT ENOUGH ON ITS OWN, stated plainly because this file
// could otherwise become the false green it exists to prevent: the original
// defect was a button whose markup, class list, aria and inline SVG were ALL
// correct while it rendered as a near-white user-agent square. No source or
// DOM assertion can see that. The measurement that can is
// scripts/verify_header_icons_and_menu.py, which reads getComputedStyle in a
// real Chromium through tests/manual/header-icons-and-menu-harness.html, and
// scripts/ci/mutate-header-icons-and-menu.sh runs BOTH this file and that
// verifier for every mutant. Treat this file as the fast structural gate and
// that script as the one that actually sees pixels.
//
// MEASURED LIVE (Playwright, headless Chromium, 1280x900, real stylesheets):
//
//   help button, BEFORE (at 04f425a, the shipped baseline):
//     background-color  rgb(239, 239, 239)   <- user-agent ButtonFace
//     border            2px outset
//     border-radius     0px                  <- a square
//     box               20x20 (shrink-wrapped, not --control-size)
//     glyph colour      rgb(215, 119, 87)    <- correct the whole time
//   help button, AFTER:
//     background-color  rgba(215, 119, 87, 0.15)  == its sibling #configEditorBtn
//     border            solid, radius 50%         == its sibling
//     gap from title    8.0px to the right of #header-title-text
//     vertical centre   0.01px off the title's centre
//
//   sidebar toggle on the home screen:
//     BEFORE  left edge 100px against a 20px header content edge (pushed
//             inboard by the 80px #header-home-spacer that precedes it),
//             flanks left 116px vs right 80px -> title 18px off centre
//     AFTER   undocked left=20, content edge=20, flanks 80 == 80
//             docked   left=340, content edge=340, flanks 80 == 80
//             (spacer 44 + toggle 36 = 80 = .controls)
//
//   A whole-app sweep of the 18 static buttons at 04f425a found EXACTLY ONE
//   rendering the user-agent default: #launchpad-help-btn. Recorded here
//   because it bounds the blast radius - the deleted bare `button {}` reset
//   did not strip any other control.
//
// Run with: node tests/test_header_help_and_toggle.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'client/css/styles.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'client/js/launchpad.js'), 'utf8');

let checks = 0;
/**
 * Assert with a counted, named check.
 * @param {boolean} cond - what must hold.
 * @param {string} msg - what it means when it does not.
 * @returns {void}
 */
function ok(cond, msg) {
    checks += 1;
    assert.ok(cond, msg);
}

// ---------------------------------------------------------------------
// 61a. THE WHITE SQUARE: the button must opt into the shared icon-button
// class. This is the structural half; the paint is measured by the
// verifier named in the header comment.
// ---------------------------------------------------------------------
const helpBtn = html.match(/<button[^>]*id="launchpad-help-btn"[^>]*>/);
ok(helpBtn, 'the help button is gone from client/index.html');
ok(/class="[^"]*\bbtn-icon\b[^"]*"/.test(helpBtn[0]),
    'the help button does not carry .btn-icon, so it falls through to the '
    + 'user-agent stylesheet and renders as a white square - the bare '
    + '`button {}` reset that used to cover it was deleted deliberately');

// The class must actually exist and still be the thing that paints a
// round, themed button. A test that asserted the class name alone would
// pass against a stylesheet that no longer defines it.
ok(/\.btn-icon\s*\{[^}]*background:\s*var\(--color-accent-bg\)/.test(css),
    '.btn-icon no longer sets the accent background the help button relies on');
ok(/\.btn-icon\s*\{[^}]*border-radius:\s*var\(--radius-full\)/.test(css),
    '.btn-icon no longer sets --radius-full, so icon buttons are not round');

// ---------------------------------------------------------------------
// 61b. BESIDE THE TITLE. The button must be a CHILD of #appTitle and must
// come after the title text, and must NOT be back inside .controls.
// ---------------------------------------------------------------------
const h1 = html.match(/<h1 id="appTitle">[\s\S]*?<\/h1>/);
ok(h1, '#appTitle is gone');
ok(h1[0].includes('id="launchpad-help-btn"'),
    'the help button is not inside #appTitle, so it no longer rides the '
    + "title's centring and will drift away from the text");
ok(h1[0].indexOf('id="header-title-text"') < h1[0].indexOf('id="launchpad-help-btn"'),
    'the help button is before the title text, not to its right');

const controls = html.match(/<div class="controls">[\s\S]*?\n        <\/div>/);
ok(controls, '.controls block is gone');
ok(!controls[0].includes('id="launchpad-help-btn"'),
    'the help button is back inside .controls, which makes the header\'s '
    + 'right flank wider than #header-home-spacer and pushes the title off centre');

ok(/\.header--home #launchpad-help-btn\s*\{[^}]*flex-shrink:\s*0/.test(css),
    'the help button is shrinkable inside the h1; header-title-fit.js '
    + 'assumes every non-title child of #appTitle is fixed-size, so a '
    + 'shrinkable one makes its budget disagree with the real layout');

// ---------------------------------------------------------------------
// 59. THE SIDEBAR TOGGLE ON THE HOME SCREEN.
// ---------------------------------------------------------------------
ok(!/app\.js never shows\s*\n\s*\*\s*it on the launchpad/.test(css),
    'the stale claim that app.js never shows the sidebar toggle on the '
    + 'launchpad is back in styles.css; showLaunchpad() calls '
    + 'SessionSidebar.show(), which un-hides it');
ok(/--home-header-toggle-w:\s*36px/.test(css),
    'the toggle-width token is gone, so the spacer cannot compensate for it');
ok(/\.header--home #session-sidebar-toggle:not\(\.hidden\)\s*\{[^}]*order:\s*-1/.test(css),
    'the toggle is no longer ordered to the content edge, so #header-home-spacer '
    + 'precedes it and pushes it inboard');
ok(/:has\(#session-sidebar-toggle:not\(\.hidden\)\)[^{]*\.header-home-spacer\s*\{[^}]*calc\(var\(--home-header-flank-w\) - var\(--home-header-toggle-w\)\)/.test(css),
    'the spacer no longer gives back the toggle\'s width, so the left flank '
    + 'is wider than the right and the title sits off centre');

// The compensation must be conditional. An unconditional shrink would put
// the title off centre the other way whenever the toggle is hidden.
ok(/:has\(#session-sidebar-toggle:not\(\.hidden\)\)/.test(css),
    'the spacer compensation is unconditional; it must only apply while the '
    + 'toggle is actually rendering');

// ---------------------------------------------------------------------
// 68. THE RENAME AFFORDANCE: ported out in slice 5, and where it went.
// ---------------------------------------------------------------------
// This block held ten source-shape assertions over `launchpad.js` -
// the three-state pencil, the `== null` ownership test, the two return
// paths, the separate class for the disabled state, the click it
// swallows. Every one of them was a grep for an EXPRESSION, which is the
// only thing a string builder gives a test to hold onto, and the string
// builder is gone: the card is
// web/src/lib/launchpad/RunningSessionRow.svelte and the decision is
// web/src/lib/launchpad/running-row.ts::renamePencilView.
//
// The RULES are unchanged and are asserted as BEHAVIOUR now, in
// web/src/lib/launchpad/running-row.test.ts (all three states, the reason
// key each carries, the `== null` third outcome, the two classes) and in
// RunningSessions.behaviour.test.ts (the control is never absent, the
// disabled one carries its reason in `title` and `aria-label` and no
// `data-rename-sid`). A port that satisfies those is correct whatever it
// renders, which is what a grep for `return \`<span` could never say.

// ---------------------------------------------------------------------
// 53b. THE ADD MENU.
// ---------------------------------------------------------------------
ok(!/data-action="open-folder"/.test(js),
    '"open from folder" is still a top-level add-menu item');
ok(!/'open-folder':/.test(js),
    'the dead open-folder dispatch key is still in the action table');
ok(/key: 'folder', label: 'open an existing folder'/.test(js),
    'the new-claude-project chooser has no "open an existing folder" option');
ok(/if \(how === 'folder'\) return this\.openProjectFromFolder\(\);/.test(js),
    'the folder choice does not route into the existing handler');
ok(/async openProjectFromFolder\(\)/.test(js),
    'openProjectFromFolder was removed; the fold-in must reuse it, not '
    + 'reimplement launch logic');

// Order of what remains, and the first item's real icon (do-not-regress).
const fabOrder = [...js.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
assert.deepEqual(fabOrder,
    ['new-claude-project', 'new-session', 'connect-openclaw', 'connect-hermes', 'new-console'],
    'the add menu order or membership changed unexpectedly');
checks += 1;
ok(/data-action="new-claude-project"[\s\S]{0,400}?assets\/icons\/header-icon\.png/.test(js),
    'the new-claude-project item lost the real app icon file');

// ---------------------------------------------------------------------
// HOUSE STYLE: no em-dashes, en-dashes or emoji in the files this branch
// touched. Counted as codepoints, never via grep - see the repo hazard
// list on why a grep for these is not evidence of absence.
// ---------------------------------------------------------------------
// SCOPED TO THE REGIONS THIS BRANCH AUTHORED, not to whole files.
// client/index.html carries 22 pre-existing em-dashes (identical count at
// 04f425a, verified), and failing on those would make this assertion a
// permanent red that says nothing about the change in front of it - the
// "furniture" failure mode the repo's own standard warns about. The two
// files this branch added prose to, styles.css and launchpad.js, are
// checked whole because their baseline count is genuinely zero.
// The h1's pre-existing brand-icon comment holds 3 of those 22, so the
// slice here is the help-button block this branch actually wrote.
const helpBlock = html.slice(
    html.indexOf('<!-- LAUNCHER HELP, BESIDE THE TITLE.'),
    html.indexOf('</button>', html.indexOf('id="launchpad-help-btn"')),
);
ok(helpBlock.length > 200, 'could not locate the help-button block to style-check it');
const authored = [
    ['help button block', helpBlock],
    ['styles.css', css],
    ['launchpad.js', js],
];
for (const [name, text] of authored) {
    const em = [...text].filter((c) => c.codePointAt(0) === 8212).length;
    const en = [...text].filter((c) => c.codePointAt(0) === 8211).length;
    ok(em === 0, `${name} contains ${em} em-dashes`);
    ok(en === 0, `${name} contains ${en} en-dashes`);
}

console.log(`test_header_help_and_toggle: ${checks} checks passed`);

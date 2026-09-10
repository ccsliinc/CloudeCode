// Update notifier: version comparison and the three outcomes.
//
// The property that matters most is the one a boolean cannot express:
// "no update available" and "could not check" must never render the same.
// A notifier that reports up-to-date whenever the network is down tells
// the user a falsehood they will act on.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const U = require('../macOS/update-check.js');

let passes = 0, failures = 0;
function test(name, fn) {
  try { fn(); passes++; }
  catch (e) { failures++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passes++; }
  catch (e) { failures++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

// ---- version comparison -------------------------------------------
test('ordinary ordering', () => {
  assert.equal(U.compareVersions('1.0.29', '1.0.30'), -1);
  assert.equal(U.compareVersions('1.0.30', '1.0.29'), 1);
  assert.equal(U.compareVersions('1.0.29', '1.0.29'), 0);
});

test('a leading v is tolerated on either side', () => {
  assert.equal(U.compareVersions('1.0.29', 'v1.0.30'), -1);
  assert.equal(U.compareVersions('v1.0.30', '1.0.30'), 0);
});

test('differing component counts compare as zero-padded', () => {
  assert.equal(U.compareVersions('1.2', '1.2.0'), 0);
  assert.equal(U.compareVersions('1.2', '1.2.1'), -1);
});

test('numeric, not lexicographic', () => {
  // The classic: "1.0.9" > "1.0.10" under string comparison.
  assert.equal(U.compareVersions('1.0.9', '1.0.10'), -1);
  assert.equal(U.compareVersions('1.0.100', '1.0.99'), 1);
});

test('an unparseable version is null, never zero', () => {
  // Returning 0 would report "current" for a version nobody understood,
  // which is the false-green this whole module is shaped against.
  assert.equal(U.compareVersions('1.0.29', 'nightly'), null);
  assert.equal(U.compareVersions(undefined, '1.0.0'), null);
  assert.equal(U.compareVersions('1.0.0', null), null);
});

// ---- the three outcomes ---------------------------------------------
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

await atest('a newer release is reported as available', async () => {
  const r = await U.checkForUpdate('1.0.29', ok({ tag_name: 'v1.0.30', html_url: 'u' }));
  assert.equal(r.result, U.RESULT_AVAILABLE);
  assert.equal(r.latest, '1.0.30');
  assert.equal(r.url, 'u');
});

await atest('the same release is reported as current', async () => {
  const r = await U.checkForUpdate('1.0.30', ok({ tag_name: 'v1.0.30' }));
  assert.equal(r.result, U.RESULT_CURRENT);
});

await atest('a NEWER local build is current, not available', async () => {
  // Building locally ahead of the last release must not nag forever.
  const r = await U.checkForUpdate('1.0.31', ok({ tag_name: 'v1.0.30' }));
  assert.equal(r.result, U.RESULT_CURRENT);
});

await atest('THE DISCRIMINATING CASE: offline is unknown, not current', async () => {
  const r = await U.checkForUpdate('1.0.29', async () => { throw new Error('offline'); });
  assert.equal(r.result, U.RESULT_UNKNOWN);
  assert.ok(r.detail, 'an unknown with no reason is not actionable');
});

await atest('a non-200 feed is unknown, not current', async () => {
  const r = await U.checkForUpdate('1.0.29', async () => ({ ok: false, status: 403 }));
  assert.equal(r.result, U.RESULT_UNKNOWN);
  assert.ok(r.detail.includes('403'), 'the status must reach the reason');
});

await atest('an unparseable tag is unknown, not current', async () => {
  const r = await U.checkForUpdate('1.0.29', ok({ tag_name: 'nightly-build' }));
  assert.equal(r.result, U.RESULT_UNKNOWN);
});

await atest('a malformed body is unknown, not current', async () => {
  const r = await U.checkForUpdate('1.0.29', async () => ({
    ok: true, status: 200, json: async () => { throw new Error('bad json'); }
  }));
  assert.equal(r.result, U.RESULT_UNKNOWN);
});

await atest('checkForUpdate never throws', async () => {
  for (const impl of [null, undefined, 'not a function']) {
    const r = await U.checkForUpdate('1.0.29', impl);
    assert.ok(r && r.result, 'must always resolve to a result');
  }
});

// ---- which repo the feed points at ---------------------------------
// PINNED ON PURPOSE. The feed URL is an outward-facing contract with every
// installed copy of this app, and it has already moved once. A change here
// must be a decision someone made, not a change someone made in passing.
test('the feed is the upstream product repo, by the 2026-09-10 ruling', () => {
  assert.equal(
    U.UPDATE_FEED_URL,
    'https://api.github.com/repos/Adoom666/CloudeCode/releases/latest',
    'both checkers point at Adoom666/CloudeCode; see docs/DECISIONS.md'
  );
});

await atest('a latest OLDER than the install is current, never a downgrade', async () => {
  // The measured state on 2026-09-10: the feed repo publishes v1.0.36 while
  // this line ships 1.2.1. The figure reported is wrong and that is a known,
  // recorded consequence. What must NEVER happen is a prompt to "upgrade"
  // onto an older release, so it is asserted with the real numbers.
  const feed = async () => ({
    ok: true, status: 200,
    json: async () => ({
      tag_name: 'v1.0.36',
      html_url: 'https://github.com/Adoom666/CloudeCode/releases/tag/v1.0.36'
    })
  });
  const r = await U.checkForUpdate('1.2.1', feed);
  assert.equal(r.result, U.RESULT_CURRENT, 'an older latest must not offer an upgrade');
  assert.notEqual(r.result, U.RESULT_AVAILABLE);
  assert.equal(r.latest, '1.0.36', 'the wrong-but-honest figure is still reported');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');

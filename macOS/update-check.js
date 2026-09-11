/**
 * Update NOTIFIER - deliberately not an auto-updater.
 *
 * WHY NOT AUTO-UPDATE. macOS auto-update runs through Squirrel.Mac, which
 * refuses to apply an update whose signature it cannot validate. This app
 * is ad-hoc signed ("0 valid identities found"), so a real auto-updater
 * needs a paid Developer ID certificate plus notarization before it can
 * work at all - and it would then swap an app bundle whose Python child
 * process owns a schema-versioned database, where a mismatched pair is a
 * broken install rather than a failed download.
 *
 * A notifier has none of that surface: it reads a version, compares, and
 * tells the user. No certificate, nothing swapped, nothing to roll back.
 *
 * THREE OUTCOMES, because "no update available" and "could not check"
 * must never render the same. A notifier that silently reports
 * up-to-date whenever the network is down is worse than no notifier: it
 * actively tells the user a falsehood they will act on.
 *
 * WHICH REPOSITORY THIS ASKS. Owner's ruling, 2026-09-08, verbatim: "use
 * adams main repo." DEFAULT_RELEASE_REPO below is the single named
 * constant for that repo - the ONE place this file's identity of "the
 * release feed" is spelled out - and every site that needs to say the
 * same repo (this module's default feed, the About window's "View on
 * GitHub" link in main.js) reads it rather than re-typing the string.
 *
 * A packaged build has no git checkout to read and nobody is expected to
 * hand-edit config.json for one, so a packaged install always resolves to
 * DEFAULT_RELEASE_REPO - that is the safe default the ruling names. A
 * developer running their own fork who wants to be told about THAT fork's
 * own tags sets `updates.remote` in config.json: the exact key
 * src/core/update_check.py already reads for the identical reason, reused
 * here rather than inventing a second setting, so one config value governs
 * both checkers on a machine instead of two separately-taught ones.
 *
 * NOT REPLICATED HERE: the Python checker's second rung, which falls back
 * to the checkout's own `git remote get-url origin` before the public
 * fallback. That rung exists there because the Python server always runs
 * from an actual git working tree. Reproducing it would mean shelling out
 * to git from the Electron main process for a rung only a developer
 * running a personal fork of the menu bar app would ever exercise. Left as
 * a known gap rather than built speculatively; the config override above
 * covers that same developer today.
 *
 * KNOWN CONSEQUENCE, stated here rather than discovered later, and carried
 * across verbatim in substance from the other line's version of this fix.
 * That repo publishes v1.0.36 while this line ships 1.2.1, so an install is
 * told the latest release is OLDER than the one it is running. It does NOT
 * prompt a downgrade: compareVersions('1.2.1', '1.0.36') is 1, and
 * checkForUpdate reports RESULT_AVAILABLE only when the comparison is
 * negative, so the outcome is RESULT_CURRENT. What IS wrong is the figure
 * reported alongside it, and the release the upgrade link opens. Both
 * suites pin those real numbers. See docs/DECISIONS.md, 2026-09-10.
 */

const fs = require('node:fs');

// The canonical release repo per the owner's ruling. Matches
// src/core/update_check.py's FALLBACK_REMOTE / DEFAULT_UPGRADE_COMMAND, so
// the two checkers name one project by default, never two.
const DEFAULT_RELEASE_REPO = 'Adoom666/CloudeCode';

const CHECK_TIMEOUT_MS = 6000;

const RESULT_CURRENT = 'current';
const RESULT_AVAILABLE = 'available';
const RESULT_UNKNOWN = 'unknown';

/**
 * Compare two semver-ish strings.
 *
 * Description: numeric, component-wise, tolerant of a leading "v" and of
 *   differing lengths ("1.2" vs "1.2.0"). Returns null when either side
 *   cannot be parsed - a comparison against an unparseable version is not
 *   0, it is unknown, and returning 0 would report "current" for a
 *   version nobody understood.
 * Inputs: a (string), b (string).
 * Output: -1 | 0 | 1 | null
 */
function compareVersions(a, b) {
  const parse = (v) => {
    if (typeof v !== 'string') return null;
    const cleaned = v.trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(cleaned)) return null;
    return cleaned.split('.').map((n) => parseInt(n, 10));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] === undefined ? 0 : pa[i];
    const y = pb[i] === undefined ? 0 : pb[i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Parse an "owner/repo" pair out of a git remote URL.
 *
 * Description: accepts the HTTPS form (`https://github.com/OWNER/REPO.git`
 *   or without the `.git` suffix) and the SSH form (`git@github.com:OWNER/
 *   REPO.git`). Anything else - a non-GitHub host, a malformed string, a
 *   non-string - returns null rather than guessing, because a wrong guess
 *   here silently points the update feed at whatever it happens to parse
 *   to.
 * Inputs: url (unknown) - a candidate git remote URL.
 * Output: string ("owner/repo") | null
 */
function ownerRepoFromRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  const match = trimmed.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Read `updates.remote` from config.json.
 *
 * Description: same key ``src.core.update_check.read_configured_remote``
 *   reads, so one setting governs both checkers. NEVER THROWS: a missing
 *   file, unparseable JSON, or an absent/malformed `updates` block are all
 *   "no override configured" rather than an error, matching the Python
 *   function's contract exactly so this optional key cannot break a menu
 *   bar launch for an install that does not set it.
 * Inputs: configPath (string | null | undefined) - path to config.json.
 * Output: string - the configured remote URL, or "" when absent/unreadable.
 */
function readConfiguredRemote(configPath) {
  if (!configPath) return '';
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // Missing file or malformed JSON: treated as "no override", not a
    // failure - see the doc comment above.
    return '';
  }
  const updates = data && data.updates;
  if (!updates || typeof updates !== 'object') return '';
  return typeof updates.remote === 'string' ? updates.remote.trim() : '';
}

/**
 * Decide which "owner/repo" this checker asks the GitHub Releases API about.
 *
 * Description: an explicit `updates.remote` in config.json, parsed to an
 *   owner/repo pair, if one is configured and parses; otherwise
 *   DEFAULT_RELEASE_REPO. See this module's header comment for the full
 *   rationale and why the default is safe.
 * Inputs: configPath (string | null | undefined) - path to config.json.
 * Output: string - "owner/repo".
 */
function resolveReleaseRepo(configPath) {
  const configured = ownerRepoFromRemoteUrl(readConfiguredRemote(configPath));
  return configured || DEFAULT_RELEASE_REPO;
}

/**
 * Build the GitHub "latest release" API URL for a repo.
 *
 * Inputs: repo (string) - "owner/repo".
 * Output: string - the full api.github.com URL.
 */
function feedUrlFor(repo) {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

// The default feed: DEFAULT_RELEASE_REPO with no config override applied.
// Exported for backward compatibility and for the module-level "what would
// this check right now" read (`node -e "console.log(require('./update-
// check.js').UPDATE_FEED_URL)"`). `checkForUpdate` itself re-resolves per
// call so a configured override still takes effect.
const UPDATE_FEED_URL = feedUrlFor(DEFAULT_RELEASE_REPO);

/**
 * Ask the feed what the latest published version is.
 *
 * Description: NEVER THROWS. Every failure - offline, timeout, rate
 *   limit, unparseable body, a tag that is not a version - resolves to
 *   RESULT_UNKNOWN with a reason. The caller renders that as "could not
 *   check", never as "up to date".
 * Inputs: currentVersion (string) - typically app.getVersion().
 *   fetchImpl (function, optional) - injected for tests.
 *   configPath (string, optional) - path to config.json, consulted for an
 *     `updates.remote` override; absent means DEFAULT_RELEASE_REPO.
 * Output: Promise<{result, current, latest, url, detail}>
 */
async function checkForUpdate(currentVersion, fetchImpl, configPath) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return {
      result: RESULT_UNKNOWN, current: currentVersion, latest: null,
      url: null, detail: 'no fetch implementation available'
    };
  }
  const feedUrl = feedUrlFor(resolveReleaseRepo(configPath));
  let body;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    let response;
    try {
      response = await doFetch(feedUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' }
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response || !response.ok) {
      return {
        result: RESULT_UNKNOWN, current: currentVersion, latest: null,
        url: null,
        detail: `feed returned ${response ? response.status : 'no response'}`
      };
    }
    body = await response.json();
  } catch (err) {
    return {
      result: RESULT_UNKNOWN, current: currentVersion, latest: null,
      url: null, detail: (err && err.message) || String(err)
    };
  }

  const latest = body && (body.tag_name || body.name);
  const cmp = compareVersions(currentVersion, latest);
  if (cmp === null) {
    return {
      result: RESULT_UNKNOWN, current: currentVersion, latest: latest || null,
      url: (body && body.html_url) || null,
      detail: `could not compare "${currentVersion}" with "${latest}"`
    };
  }
  return {
    result: cmp < 0 ? RESULT_AVAILABLE : RESULT_CURRENT,
    current: currentVersion,
    latest: String(latest).replace(/^v/i, ''),
    url: (body && body.html_url) || null,
    detail: null
  };
}

module.exports = {
  DEFAULT_RELEASE_REPO,
  UPDATE_FEED_URL,
  RESULT_CURRENT,
  RESULT_AVAILABLE,
  RESULT_UNKNOWN,
  compareVersions,
  ownerRepoFromRemoteUrl,
  readConfiguredRemote,
  resolveReleaseRepo,
  feedUrlFor,
  checkForUpdate
};

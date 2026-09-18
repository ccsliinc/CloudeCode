'use strict';

/**
 * electron-builder `afterPack` hook: sign the packed .app bundle.
 *
 * WHY THIS EXISTS
 * ---------------
 * electron-builder signs only when it can resolve a real signing identity, and
 * CI explicitly sets CSC_IDENTITY_AUTO_DISCOVERY=false, so it logs "skipped
 * macOS application code signing" and moves on with exit 0.
 *
 * The bundle it leaves behind is not merely unsigned, it is BROKEN. There is
 * no `Contents/_CodeSignature` directory at all, so the only signature is the
 * ad-hoc one the linker puts on the arm64 Mach-O executable. That combination
 * makes both of these fail:
 *
 *     codesign --verify --deep --strict "Cloude Code.app"
 *     spctl --assess --type execute "Cloude Code.app"
 *
 * with "code has no resources but signature indicates they must be present".
 * Once a browser download adds com.apple.quarantine, macOS does not show the
 * ordinary "unidentified developer" prompt (which right click > Open clears).
 * It shows "Cloude Code is damaged and can't be opened", which right click >
 * Open does NOT clear. The user's only escape is `xattr -dr
 * com.apple.quarantine` in Terminal. For a release aimed at non-developers
 * that is a hard blocker.
 *
 * WHY IT PREFERS A CERTIFICATE OVER AD HOC
 * ----------------------------------------
 * An ad-hoc signature carries no identity, so its designated requirement is a
 * bare `cdhash H"..."`: a fingerprint of the exact bytes, which changes on
 * every single build. macOS privacy consent (TCC) stores that requirement
 * alongside each Allow the user clicks, so with an ad-hoc bundle every rebuild
 * invalidates every grant the user has ever given this app, and the prompts
 * come back forever. That is not a theoretical cost: this app is the
 * responsible parent process for everything its terminal panes spawn, so it
 * is the bundle macOS names in those prompts.
 *
 * A certificate-backed signature produces an identity-anchored requirement
 * instead, of the shape
 *
 *     identifier "com.cloudecode.menubar" and anchor apple generic and
 *     certificate leaf[subject.CN] = "..." and certificate 1[field...]
 *
 * which contains no hash of the build output and therefore survives every
 * rebuild. One Allow, written once, keeps matching.
 *
 * Preference order, highest first:
 *
 *   1. CLOUDE_SIGN_IDENTITY, if set, matched against the identity list.
 *   2. Developer ID Application, the only identity Gatekeeper accepts for
 *      software distributed outside the App Store.
 *   3. Apple Development, which is the right certificate for a build that runs
 *      on the developer's own machines.
 *   4. Ad hoc, unchanged from the behaviour above.
 *
 * Apple Distribution is deliberately NOT used. It is for App Store and
 * TestFlight submission and expects an embedded provisioning profile; a
 * directly launched build signed with it can be refused at exec.
 *
 * WHY THERE IS NO HARDENED RUNTIME
 * --------------------------------
 * `--options runtime` is absent on purpose. It is a prerequisite for
 * notarization, which needs a Developer ID certificate this project does not
 * have, and on Electron it additionally demands a set of JIT and
 * library-validation entitlements whose absence shows up as a crash at launch
 * rather than an error at build time. The goal here is a stable identity, not
 * a notarized artifact, and the hardened runtime contributes nothing to that.
 *
 * WHY A HOOK AND NOT A CONFIG FLAG
 * --------------------------------
 * electron-builder has no "ad-hoc sign" setting, and `mac.identity: null` and
 * CSC_IDENTITY_AUTO_DISCOVERY=false both mean SKIP, which on its own is the
 * broken state above. Doing it in `afterPack` runs after the .app is fully
 * packed but before the DMG is assembled, so the DMG contains the signed
 * bundle, and the fallback path behaves identically on a laptop and on a
 * GitHub runner because it depends on no keychain state whatsoever.
 *
 * `mac.identity` is therefore pinned to null in package.json, which makes this
 * hook the single owner of signing. electron-builder runs its own signing pass
 * AFTER afterPack, so without that pin a machine that happens to hold a
 * Developer ID certificate would have this hook's inside-out work silently
 * replaced by electron-builder's, under a hardened runtime whose entitlements
 * nobody here has tested. One signer, one order, one result on every machine.
 *
 * This file lives in `macOS/scripts/` rather than `macOS/build/` only because
 * the repo's root .gitignore ignores every directory named `build`. It is
 * build-time tooling and is excluded from the shipped asar by the `!scripts`
 * entry in the `files` array in package.json.
 *
 * WHY IT THROWS
 * -------------
 * The defect that produced this blocker was a skipped signing step that still
 * exited 0, so every downstream signal looked fine. This hook verifies its own
 * work and throws on failure, making an unsignable bundle a loud build failure
 * instead of a DMG that only misbehaves on the user's machine.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Mach-O magic numbers, thin and fat, both byte orders. */
const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/**
 * Run a command, returning stdout as a string. Throws on non-zero exit with
 * stderr attached, since every caller here treats failure as fatal.
 *
 * @param {string} cmd Executable name.
 * @param {string[]} args Arguments.
 * @returns {string} stdout, trimmed.
 */
function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Run a command and return stdout and stderr joined. `codesign -d` prints its
 * report on STDERR, so a caller that reads stdout alone inspects an empty
 * string and can only ever reach the wrong conclusion.
 *
 * @param {string} cmd Executable name.
 * @param {string[]} args Arguments.
 * @returns {string} Both streams, concatenated and trimmed.
 * @throws {Error} If the command could not be run or exited non-zero.
 */
function runBothStreams(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

/**
 * Choose the signing identity to use, by the preference order documented at
 * the top of this file.
 *
 * @returns {string|null} A codesign identity string (the certificate's common
 *   name), or null when no usable certificate is installed and the caller
 *   should fall back to ad-hoc signing.
 * @example
 *   chooseIdentity() // "Apple Development: Adam Callen (LG2BL48ZP2)"
 */
function chooseIdentity() {
  let listing;
  try {
    listing = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch (err) {
    // No keychain, locked keychain, or no security binary. Ad-hoc is correct.
    return null;
  }

  // Lines look like:  1) <40 hex chars> "Apple Development: Name (TEAMID)"
  const names = [];
  for (const line of listing.split('\n')) {
    const match = line.match(/^\s*\d+\)\s+[0-9A-F]{40}\s+"(.+)"\s*$/);
    if (match) {
      names.push(match[1]);
    }
  }
  if (names.length === 0) {
    return null;
  }

  const requested = process.env.CLOUDE_SIGN_IDENTITY;
  if (requested) {
    const exact = names.find((n) => n === requested) || names.find((n) => n.includes(requested));
    if (!exact) {
      throw new Error(
        `CLOUDE_SIGN_IDENTITY is set to "${requested}" but no installed codesigning ` +
          `identity matches it. Installed identities: ${names.join(', ') || '(none)'}`
      );
    }
    return exact;
  }

  return (
    names.find((n) => n.startsWith('Developer ID Application')) ||
    names.find((n) => n.startsWith('Apple Development')) ||
    null
  );
}

/**
 * Report whether a file begins with a Mach-O magic number, which is what
 * separates a binary codesign can sign from a script that merely has its
 * execute bit set.
 *
 * @param {string} filePath Absolute path to a regular file.
 * @returns {boolean} True when the file is Mach-O.
 */
function isMachO(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) {
      return false;
    }
    return MACH_O_MAGIC.has(head.readUInt32BE(0)) || MACH_O_MAGIC.has(head.readUInt32LE(0));
  } catch (err) {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Collect every path inside a bundle that has to be signed, in the order
 * codesign requires: nested code before the code that seals it.
 *
 * Symlinks are skipped, so a framework's `Versions/Current` shortcut never
 * causes the same binary to be signed twice by two different names.
 *
 * @param {string} appPath Absolute path to the .app bundle.
 * @returns {string[]} Absolute paths, innermost first, with appPath last.
 * @example
 *   collectSigningTargets('/Applications/Cloude Code.app')
 *   // [ '.../Libraries/libEGL.dylib', ..., '.../Cloude Code Helper.app',
 *   //   '/Applications/Cloude Code.app' ]
 */
function collectSigningTargets(appPath) {
  const looseBinaries = [];
  const nestedBundles = [];

  /**
   * @param {string} dir Directory to descend into.
   * @returns {void}
   */
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (full !== appPath && (entry.name.endsWith('.app') || entry.name.endsWith('.framework'))) {
          nestedBundles.push(full);
        }
        walk(full);
      } else if (entry.isFile() && isMachO(full)) {
        looseBinaries.push(full);
      }
    }
  }
  walk(appPath);

  // Deepest first, so a framework's contents are sealed before the framework.
  const byDepthDescending = (a, b) => b.split(path.sep).length - a.split(path.sep).length;
  looseBinaries.sort(byDepthDescending);
  nestedBundles.sort(byDepthDescending);

  return [...looseBinaries, ...nestedBundles, appPath];
}

/**
 * Sign a macOS bundle and prove the signature is structurally valid.
 *
 * With a certificate this signs inside out, one target at a time, because
 * Apple documents `--deep` as the wrong tool for a real identity: it applies
 * one flat set of options to every nested binary. With no certificate it uses
 * `--deep` for the ad-hoc pass, where that objection does not apply because
 * there are no per-target entitlements to get wrong.
 *
 * @param {string} appPath Absolute path to the .app bundle.
 * @param {string|null} [identity] Certificate common name, or null or omitted
 *   to sign ad hoc. Defaults to the result of chooseIdentity().
 * @returns {void}
 * @throws {Error} If signing or verification fails, or _CodeSignature is absent.
 */
function adhocSign(appPath, identity = chooseIdentity()) {
  if (identity) {
    // A timestamp keeps the signature valid after the certificate expires,
    // which matters here precisely because the point is that it never changes.
    for (const target of collectSigningTargets(appPath)) {
      run('codesign', ['--force', '--timestamp', '--sign', identity, target]);
    }
  } else {
    run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
  }

  // Proof 1: the sealed-resources directory must now exist. Its absence was
  // the entire failure mode, so check the artifact directly, not the exit code.
  const sigDir = path.join(appPath, 'Contents', '_CodeSignature');
  if (!fs.existsSync(path.join(sigDir, 'CodeResources'))) {
    throw new Error(
      `signing reported success but ${sigDir}/CodeResources does not exist. ` +
        'The bundle would show "damaged and can\'t be opened" once quarantined.'
    );
  }

  // Proof 2: the signature verifies strictly, including nested code.
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

  // Proof 3: a certificate pass must actually have produced an identity. An
  // ad-hoc result here would mean the rebuild problem is still present and
  // every privacy consent the user grants is about to expire at the next
  // build, which is the defect this hook exists to prevent.
  if (identity) {
    const details = runBothStreams('codesign', ['-dv', '--verbose=4', appPath]);
    if (/flags=0x[0-9a-f]*\([^)]*adhoc/.test(details) || !/\nTeamIdentifier=(?!not set)/.test(`\n${details}`)) {
      throw new Error(
        `signed with "${identity}" but the result is still ad-hoc or carries no team identifier. ` +
          'Privacy consent would not survive the next build.'
      );
    }
  }
}

/**
 * electron-builder afterPack entry point.
 *
 * @param {object} context electron-builder hook context.
 * @param {string} context.appOutDir Directory holding the packed .app.
 * @param {string} context.electronPlatformName Platform being packed.
 * @param {object} context.packager Packager, used for the product filename.
 * @returns {Promise<void>}
 */
module.exports = async function adhocSignHook(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    throw new Error(`afterPack: expected bundle not found at ${appPath}`);
  }

  const identity = chooseIdentity();
  console.log(`[adhoc-sign] signing ${appPath} as ${identity || 'ad hoc (no certificate installed)'}`);
  adhocSign(appPath, identity);
  console.log(
    identity
      ? `[adhoc-sign] signature present and verified (${identity})`
      : '[adhoc-sign] signature present and verified (ad-hoc, no identity)'
  );
};

// Exported for the unit test, which checks the hook's contract without
// running a full electron-builder pack.
module.exports.adhocSign = adhocSign;
module.exports.chooseIdentity = chooseIdentity;
module.exports.collectSigningTargets = collectSigningTargets;

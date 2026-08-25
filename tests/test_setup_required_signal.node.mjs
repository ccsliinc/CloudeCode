// Node test for ServerManager.checkConfiguration().
//
// WHY THIS FILE EXISTS
//
// This function decides whether the tray shows "Configuration: Setup Required"
// and offers the "Run Setup Script" item. It was checking for three Cloudflare
// variables that the Cloudflare tunnel system took with it when it was removed
// (Plan v3.2). They are not in .env.example any more, so no install can ever
// have them, so isConfigured was permanently false on a correctly provisioned
// machine.
//
// That is not a cosmetic wrong label. It is the thing that put a "Run Setup
// Script" button in front of a user who was already fully set up, and running
// setup a second time is what destroyed his paired TOTP secret. A check that
// can only ever say "broken" is furniture, and this one had a destructive
// action wired to it.
//
// Run with: node tests/test_setup_required_signal.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const macDir = path.join(here, '..', 'macOS');

/**
 * Load ServerManager in a vm sandbox with `electron` and `axios` stubbed.
 *
 * Both are Electron-bundle dependencies not installed at the repo root, and
 * neither is reached by checkConfiguration(). Same loader shape as
 * tests/test_settings_menubar.node.mjs.
 *
 * @param {string} baseDir - Directory standing in for the install root.
 * @returns {object} A ServerManager pointed at baseDir.
 */
function loadManager(baseDir) {
  const source = fs.readFileSync(path.join(macDir, 'server-manager.js'), 'utf8');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setupsignal-ud-'));
  const electronStub = {
    app: {
      getPath: () => userData,
      getAppPath: () => baseDir,
      isPackaged: false,
      getVersion: () => '0.0.0-test',
    },
  };
  const nodeRequire = Module.createRequire(path.join(macDir, 'server-manager.js'));
  const requireShim = (name) => {
    if (name === 'electron') return electronStub;
    if (name === 'axios') return { get: async () => ({ data: {} }) };
    return nodeRequire(name);
  };
  const sandbox = {
    require: requireShim,
    module: { exports: {} },
    exports: {},
    __dirname: macDir,
    __filename: path.join(macDir, 'server-manager.js'),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'server-manager.js' });
  const ServerManager = sandbox.module.exports;
  const manager = new ServerManager();
  manager.baseDir = baseDir;
  return manager;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/**
 * Build a throwaway install directory with a .env and config.json.
 *
 * Every secret written here is a literal placeholder invented for the test.
 * Nothing is read from any real install.
 *
 * @param {string} envBody - Contents of the .env file.
 * @returns {string} Path to the temporary directory.
 */
function makeInstall(envBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setupsignal-'));
  fs.writeFileSync(path.join(dir, '.env'), envBody, 'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'setup_auth.py'), '# placeholder\n', 'utf8');
  return dir;
}

const COMPLETE_ENV = [
  'DEFAULT_WORKING_DIR=/tmp/cc-projects',
  'LOG_DIRECTORY=/tmp/cc-logs',
  'TOTP_SECRET=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
  'JWT_SECRET=placeholder-not-a-real-secret',
  '',
].join('\n');

console.log('checkConfiguration()');

check('a fully provisioned install reports isConfigured', () => {
  const dir = makeInstall(COMPLETE_ENV);
  const status = loadManager(dir).checkConfiguration();
  assert.equal(
    status.isConfigured,
    true,
    'a complete install was told to run setup again; running setup again is ' +
      'what destroys the paired TOTP secret'
  );
  // Arrays built inside the vm sandbox are cross-realm, so compare
  // contents rather than identity.
  assert.equal(status.missingEnvVars.join(','), '');
});

check('a missing TOTP_SECRET still reports setup required', () => {
  const dir = makeInstall(COMPLETE_ENV.replace(/^TOTP_SECRET=.*$/m, 'TOTP_SECRET='));
  const status = loadManager(dir).checkConfiguration();
  assert.equal(status.isConfigured, false);
  assert.ok(status.missingEnvVars.includes('TOTP_SECRET'));
});

check('a missing JWT_SECRET still reports setup required', () => {
  const dir = makeInstall(COMPLETE_ENV.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET='));
  const status = loadManager(dir).checkConfiguration();
  assert.equal(status.isConfigured, false);
  assert.ok(status.missingEnvVars.includes('JWT_SECRET'));
});

check('no Cloudflare variable is required any more', () => {
  const dir = makeInstall(COMPLETE_ENV);
  const status = loadManager(dir).checkConfiguration();
  const cloudflare = status.missingEnvVars.filter((v) => v.startsWith('CLOUDFLARE_'));
  assert.equal(
    cloudflare.join(','),
    '',
    'checkConfiguration still demands variables the tunnel removal deleted'
  );
});

check('an absent .env reports setup required, not configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setupsignal-empty-'));
  const status = loadManager(dir).checkConfiguration();
  assert.equal(status.isConfigured, false);
  assert.ok(status.missingFiles.includes('.env'));
});

console.log(`\n${passed} checks passed`);

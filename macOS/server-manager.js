const { spawn, exec } = require('child_process');
const path = require('path');
const axios = require('axios');
const { app } = require('electron');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { currentTotp, secondsUntilRollover } = require('./totp');
const setupVerdict = require('./setup-verdict');

// Default bind host = 0.0.0.0 (listen on all interfaces). Matches the
// pydantic Settings default in src/config.py; changing here without
// changing there would cause a silent drift.
const DEFAULT_BIND_HOST = '0.0.0.0';

// Default server port. Matches the pydantic Settings default in
// src/config.py (Settings.port: int = 8000) - the single documented
// default for this whole app. Used ONLY when .env has no PORT= override,
// which is exactly when Settings.port would resolve to this same value on
// the Python side. Never used as a silent fallback for a malformed PORT=
// value - see getPort() below.
const DEFAULT_PORT = 8000;

const { listBindableIps, isTailscaleIp } = require('./network-interfaces');

// Interface selection lives in network-interfaces.js. Interfaces are chosen
// by the ADDRESS they carry, not by a blocklist of names; see that file for
// why the old name-based filter was wrong and what it cost.

class ServerManager {
  constructor() {
    this.process = null;
    this.processPid = null;
    this.ownedProcess = false; // true if we spawned the server, false if adopted
    this.logStream = null;

    // Crash tracking. `state` stays a three-value machine
    // (stopped/starting/running) so no existing menu logic changes; the
    // question "was the last exit OUR idea" is tracked separately here and
    // read by the tray to tell a deliberate stop apart from a crash. Without
    // it, a server that died on its own shows the same calm icon as one the
    // user stopped himself.
    this.stopRequested = false;
    this.lastExitUnexpected = false;
    this.lastExit = null;

    // Determine base directory based on whether app is packaged
    if (app.isPackaged) {
      // In production: Store server files in Application Support
      // This makes the app portable across different machines
      this.baseDir = path.join(app.getPath('userData'), 'server');
      this.appResourcesPath = path.join(app.getAppPath(), '..');
    } else {
      // In development (`npm start`): main.js's runBootstrap() always
      // preps venv/.env/copied src+client under userData/server (see
      // main.js's `serverDir` constant), regardless of app.isPackaged.
      // baseDir must match that, or ensureServerFiles()/getPort() look
      // for .env in the repo root, which bootstrap never touches, and
      // startup fails with "Configuration validation failed: .env file
      // not found" even though bootstrap just finished successfully.
      this.baseDir = path.join(app.getPath('userData'), 'server');
      this.appResourcesPath = this.baseDir;
    }

    // Auto-detect Python installation
    this.pythonPath = this.findPython();
    // Port is NOT cached on the instance - it is resolved fresh from .env
    // on every read via getPort(), the same way getBindHost() is fresh
    // from settings on every read. Caching it here previously meant a
    // user-edited PORT= in .env was silently ignored by the whole app
    // (health probes, port-in-use checks, "Open in Browser") while the
    // Python server itself honored it - see getPort()'s docstring.
    // Use userData/logs for persistent logging
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFile = path.join(logDir, 'server.log');
    this.state = 'stopped'; // 'stopped', 'starting', 'running'
    this.startTime = null;

    // Settings file for persistent menu-bar prefs (currently only bind_host).
    // Lives in userData root — small, atomic-written, one object deep.
    this.settingsPath = path.join(app.getPath('userData'), 'menubar-settings.json');
    this._settings = this._loadSettings();

    // What the SERVER says it is actually bound to, and its setup verdict,
    // both read from GET /health. Null means "not asked yet", which is a
    // third outcome and never rendered as either answer.
    //
    // These exist because the configured bind host and the real one can
    // legitimately disagree: while setup is incomplete the server pins
    // itself to 127.0.0.1 regardless of configuration (see
    // src/core/setup_state.py). Showing the configured value in that window
    // would put an address in the menu that nothing is listening on.
    this.reportedBind = null;
    this.reportedSetupStatus = null;
  }

  // ---------------------------------------------------------------------
  // Settings persistence (menubar-settings.json)
  // ---------------------------------------------------------------------

  /**
   * Load settings from disk. Returns an object with defaults filled in.
   * Silently recovers from missing/corrupt file by returning defaults.
   */
  _loadSettings() {
    const defaults = { bind_host: DEFAULT_BIND_HOST };
    try {
      if (!fs.existsSync(this.settingsPath)) return defaults;
      const raw = fs.readFileSync(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed };
    } catch (err) {
      console.warn('[settings] could not load, using defaults:', err.message);
      return defaults;
    }
  }

  /**
   * Atomic write of settings to disk (write-temp-then-rename).
   */
  _saveSettings() {
    try {
      const tmp = this.settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._settings, null, 2), 'utf8');
      fs.renameSync(tmp, this.settingsPath);
    } catch (err) {
      console.error('[settings] save failed:', err.message);
    }
  }

  /**
   * Path to the config.json the Python server reads.
   *
   * feat/settings-gui put the bind preference there, so both surfaces
   * that can change it - the web app's settings screen and this tray
   * menu - are writing one value in one place. Two files each claiming
   * to hold the preference is how a menu ends up disagreeing with the
   * screen that set it.
   *
   * @returns {string} absolute path to config.json.
   */
  getConfigPath() {
    return path.join(this.baseDir, 'config.json');
  }

  /**
   * Read the bind preference out of config.json.
   *
   * Three outcomes, and the third is not a value: a missing file, a
   * missing block, or unreadable JSON all return null, meaning "config
   * expresses no preference", which is different from "config says
   * loopback". The caller falls back rather than treating an unreadable
   * file as an answer.
   *
   * @returns {?string} the stored address, or null when none is stored.
   */
  readConfigBindHost() {
    try {
      const raw = fs.readFileSync(this.getConfigPath(), 'utf8');
      const parsed = JSON.parse(raw);
      const prefs = parsed && parsed.server_prefs;
      const host = prefs && prefs.bind_host;
      return (typeof host === 'string' && host.trim()) ? host.trim() : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Persist the bind preference into config.json.
   *
   * Read-modify-write with a tmp file and a rename, matching the atomic
   * convention src/config.py already uses on this same file, so no crash
   * mid-write can leave a torn config. It re-reads immediately before
   * writing so it MERGES into whatever is on disk rather than replacing
   * it - a settings-screen save that landed a moment ago survives.
   *
   * The honest limitation: read-modify-write leaves a lost-update window
   * of microseconds against a simultaneous write from the Python side.
   * Closing it properly needs a lock this codebase does not have, and the
   * two writers here are both a human physically choosing a menu item, so
   * the window is stated rather than papered over.
   *
   * @param {string} ip - the address to store.
   * @returns {boolean} whether the write happened.
   */
  writeConfigBindHost(ip) {
    const configPath = this.getConfigPath();
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      parsed.server_prefs = Object.assign({}, parsed.server_prefs, { bind_host: ip });
      const tmp = configPath + '.menubar.tmp';
      fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8');
      fs.renameSync(tmp, configPath);
      return true;
    } catch (err) {
      console.warn('[bind-host] could not write config.json:', err.message);
      return false;
    }
  }

  /**
   * Current bind host ('0.0.0.0' | '127.0.0.1' | specific LAN IP).
   *
   * config.json wins, because that is where the settings screen writes
   * and where the user was told the preference lives. menubar-settings
   * .json remains the fallback for an install that predates the settings
   * screen, so nobody's existing choice is silently reset to the default
   * by this change.
   */
  getBindHost() {
    return this.readConfigBindHost()
      || this._settings.bind_host
      || DEFAULT_BIND_HOST;
  }

  /**
   * Resolve the configured server port by reading PORT= from the server's
   * .env - the same file uvicorn/pydantic-settings load (src/config.py's
   * Settings.port), so this is guaranteed to agree with what the Python
   * process actually binds to. This is the single place in the Electron
   * app that knows how to answer "what port is the server on"; every
   * other method calls this instead of holding its own copy.
   *
   * Three-outcome contract (this repo's governing standard - see
   * CLAUDE.md "THE THREE-OUTCOME RULE"):
   *   - .env absent, or present with no PORT= line -> DEFAULT_PORT. This
   *     is a real, fully-determined answer ("no override configured"),
   *     identical to what Settings.port's own field default resolves to
   *     inside the server - not a guess.
   *   - PORT= present and a valid 1-65535 integer -> that value.
   *   - PORT= present but not a valid integer -> throws. This is the
   *     "could not determine" outcome. It must never be silently coerced
   *     to DEFAULT_PORT and reported as success - that is precisely the
   *     false-green class documented in CLAUDE.md hazard list (a script
   *     that cannot measure something must say so, not guess).
   *
   * @returns {number} the resolved port (1-65535).
   * @throws {Error} when .env exists and cannot be read, or its PORT=
   *   value is not a valid port number.
   */
  getPort() {
    const envPath = path.join(this.baseDir, '.env');
    if (!fs.existsSync(envPath)) {
      return DEFAULT_PORT;
    }
    let envText;
    try {
      envText = fs.readFileSync(envPath, 'utf8');
    } catch (err) {
      throw new Error(`could not read .env to resolve PORT: ${err.message}`);
    }
    const m = envText.match(/^PORT=(.*)$/m);
    if (!m) {
      return DEFAULT_PORT;
    }
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '').trim();
    if (raw === '') {
      return DEFAULT_PORT;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`PORT in .env is not a valid port number: "${raw}"`);
    }
    return parsed;
  }

  /**
   * Persist a new bind host and trigger a server restart so uvicorn
   * re-binds. No-op if the value is unchanged.
   */
  async setBindHost(ip) {
    if (!ip || typeof ip !== 'string') {
      throw new Error(`invalid bind host: ${ip}`);
    }
    // Compared against the EFFECTIVE value, not the menubar mirror. With
    // config.json as the source of truth, the mirror can legitimately be
    // stale, and comparing against it would refuse a change that has not
    // actually been made.
    if (this.getBindHost() === ip) {
      console.log(`[bind-host] already set to ${ip}, no-op`);
      return;
    }
    console.log(`[bind-host] change: ${this._settings.bind_host} -> ${ip}`);
    this._settings.bind_host = ip;
    this._saveSettings();
    // config.json is the source of truth the settings screen reads, so a
    // tray pick has to land there too or the two surfaces disagree about
    // what the user last chose.
    this.writeConfigBindHost(ip);

    // Full restart is required — uvicorn binds at startup and has no
    // in-place rebind. tmux sessions survive because the tmux server is
    // a separate daemon (session_manager rehydrates on lifespan_startup).
    await this.restart();
  }

  /**
   * Enumerate IPv4 LAN interface IPs suitable for binding.
   * Filters out: loopback (internal), link-local 169.254.x, and macOS
   * pseudo-interfaces (awdl/llw/utun/anpi/ap).
   * Returns: [{iface: 'en0', ip: '192.168.1.250'}, ...]
   */
  getLocalInterfaceIps() {
    try {
      return listBindableIps();
    } catch (err) {
      console.warn('[bind-host] networkInterfaces() failed:', err.message);
      return [];
    }
  }

  /**
   * Primary LAN IP — first non-loopback IPv4 from getLocalInterfaceIps().
   * Used to resolve "0.0.0.0" into a copyable URL. Returns null if no
   * LAN iface is available (airgapped Mac) — caller falls back to 127.
   */
  getPrimaryLanIp() {
    const ips = this.getLocalInterfaceIps();
    return ips.length > 0 ? ips[0].ip : null;
  }

  /**
   * Compute the currently-reachable URL for this server based on bind
   * host. Tunnel URL resolution is not done here because the /tunnels
   * endpoint is auth-gated and the Electron app has no JWT — users with
   * tunnels active get the LAN URL as a sensible fallback.
   *
   * Returns null (never a URL built from a guessed port) when getPort()
   * cannot determine the configured port - see getPort()'s three-outcome
   * docstring. Callers must treat null as "unknown", not retry with
   * DEFAULT_PORT themselves.
   */
  getPublishedUrl() {
    let port;
    try {
      port = this.getPort();
    } catch (err) {
      console.error(`[port] getPublishedUrl: ${err.message}`);
      return null;
    }
    // The MEASURED bind wins over the configured one whenever the server has
    // told us. During the setup lockdown they differ, and handing the browser
    // the configured address would open a URL nothing is listening on.
    const host = this.getEffectiveBindHost() || this.getBindHost();
    if (host === '0.0.0.0') {
      const lan = this.getPrimaryLanIp();
      return `http://${lan || '127.0.0.1'}:${port}`;
    }
    return `http://${host}:${port}`;
  }

  /**
   * Host the Electron app should use for internal HTTP probes (/health,
   * /api/v1/auth/qr, etc.).
   *
   * Bug context: uvicorn binds EXCLUSIVELY to the configured host. When
   * the user picks a specific LAN IP like 192.168.1.250, the loopback
   * interface is NOT listening — so probing 127.0.0.1 returns ECONNREFUSED
   * forever and the tray icon hangs on "starting". We must probe the
   * actual bound interface.
   *
   * Exception: when bind is 0.0.0.0 the server listens on every interface
   * including loopback, so 127.0.0.1 is always reachable and preferred
   * (no dependency on LAN state for internal probes).
   */
  getLocalProbeHost() {
    const h = this.getBindHost();
    return (h === '0.0.0.0' || !h) ? '127.0.0.1' : h;
  }

  /**
   * Fully-qualified base URL for internal HTTP probes. Replaces the old
   * hardcoded `this.apiUrl = 'http://127.0.0.1:8000'` — that constant broke
   * the moment the user chose a non-loopback bind host. The port half of
   * this had the identical bug (a hardcoded `this.port = 8000` that never
   * read a user's PORT= override) until getPort() replaced it.
   *
   * Returns null when getPort() cannot determine the configured port -
   * see getPort()'s three-outcome docstring. A null-built URL is an
   * obviously-broken one, which is the correct outcome here: it must
   * never silently probe DEFAULT_PORT and let a caller believe that
   * probe result describes the user's actual configuration.
   */
  probeHostCandidates() {
    const candidates = [this.getLocalProbeHost()];
    // The setup lockdown can put the server on loopback while configuration
    // names a LAN address. Probing only the configured address in that state
    // returns ECONNREFUSED forever and the tray reports a healthy server as
    // dead - a false negative manufactured by our own security feature.
    if (!candidates.includes('127.0.0.1')) candidates.push('127.0.0.1');
    return candidates;
  }

  /**
   * Base URL the Electron app should use for internal probes.
   *
   * @returns {string|null} The URL, or null when the port is undeterminable.
   */
  getLocalApiUrl() {
    let port;
    try {
      port = this.getPort();
    } catch (err) {
      console.error(`[port] getLocalApiUrl: ${err.message}`);
      return null;
    }
    return `http://${this.getLocalProbeHost()}:${port}`;
  }

  /**
   * Current 6-digit TOTP code, or null if we can't compute one.
   *
   * Reads TOTP_SECRET from the server's .env (same file uvicorn uses, so
   * the code we surface ALWAYS matches what the server will accept on
   * /api/v1/auth/login). Recomputes on every call — caller (menu rebuild
   * on each health poll) gets a fresh code every ~5s.
   *
   * Returns null on any failure — caller renders a disabled placeholder
   * instead of crashing the menu.
   */
  getCurrentOtp() {
    try {
      const envPath = path.join(this.baseDir, '.env');
      if (!fs.existsSync(envPath)) return null;
      const envText = fs.readFileSync(envPath, 'utf8');
      const m = envText.match(/^TOTP_SECRET=(.*)$/m);
      if (!m) return null;
      // Trim optional surrounding quotes + whitespace.
      const secret = m[1].trim().replace(/^['"]|['"]$/g, '').trim();
      if (!secret) return null;
      return currentTotp(secret);
    } catch (err) {
      console.warn('[otp] getCurrentOtp failed:', err.message);
      return null;
    }
  }

  /**
   * Seconds until the current TOTP window rolls over. Used by the tray
   * menu to decorate the Copy OTP label with "(rolls in Xs)" so users
   * know whether to grab-and-go or wait a tick.
   */
  getOtpSecondsRemaining() {
    return secondsUntilRollover();
  }

  /**
   * Find Python 3 installation on the system
   * @returns {string} Path to python3 executable
   */
  findPython() {
    // In development, prefer local venv
    if (!app.isPackaged) {
      const localVenv = path.join(this.baseDir, 'venv', 'bin', 'python3');
      if (fs.existsSync(localVenv)) {
        console.log(`Using local venv Python: ${localVenv}`);
        return localVenv;
      }
    }

    // Check common Python installation locations
    const pythonLocations = [
      '/opt/homebrew/bin/python3',     // Apple Silicon Homebrew
      '/usr/local/bin/python3',        // Intel Homebrew
      '/usr/bin/python3',              // System Python
      path.join(process.env.HOME || '', '.pyenv', 'shims', 'python3'), // pyenv
    ];

    for (const location of pythonLocations) {
      if (fs.existsSync(location)) {
        console.log(`Found Python at: ${location}`);
        return location;
      }
    }

    // Fallback to PATH
    console.log('Using python3 from PATH');
    return 'python3';
  }

  /**
   * Ensure cloudflared is installed
   */
  async ensureCloudflared() {
    const binDir = path.join(this.baseDir, 'bin');
    const cloudflaredPath = path.join(binDir, 'cloudflared');

    // Check if already exists
    if (fs.existsSync(cloudflaredPath)) {
      console.log('cloudflared found at:', cloudflaredPath);
      return cloudflaredPath;
    }

    // Check if in global PATH
    try {
      const { stdout } = await new Promise((resolve) => exec('which cloudflared', (err, stdout) => resolve({ stdout })));
      if (stdout && stdout.trim()) {
        console.log('cloudflared found in PATH:', stdout.trim());
        return 'cloudflared';
      }
    } catch (e) {
      // Ignore
    }

    console.log('cloudflared not found, downloading...');

    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;

    console.log(`Downloading from ${url}...`);

    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
      });

      const tgzPath = path.join(binDir, 'cloudflared.tgz');
      const writer = fs.createWriteStream(tgzPath);

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.log('Download complete, extracting...');

      await new Promise((resolve, reject) => {
        exec(`tar -xzf "${tgzPath}" -C "${binDir}"`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Cleanup tgz
      fs.unlinkSync(tgzPath);

      // Ensure executable
      fs.chmodSync(cloudflaredPath, '755');

      console.log('cloudflared installed successfully');
      return cloudflaredPath;

    } catch (err) {
      console.error('Failed to download cloudflared:', err);
      throw new Error('Failed to download cloudflared: ' + err.message);
    }
  }

  /**
   * Ensure server files exist in baseDir
   * Copies from bundled resources if needed (packaged app)
   */
  async ensureServerFiles() {
    const requiredDirs = ['src', 'client'];
    const requiredFiles = ['setup_auth.py', 'requirements.txt', 'config.example.json', 'nuke.sh', '.env.example'];

    // Create baseDir if it doesn't exist
    if (!fs.existsSync(this.baseDir)) {
      console.log(`Creating baseDir: ${this.baseDir}`);
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    if (app.isPackaged) {
      // Copy files from app resources to Application Support
      const resourcesPath = this.appResourcesPath;

      for (const dir of requiredDirs) {
        const srcPath = path.join(resourcesPath, dir);
        const destPath = path.join(this.baseDir, dir);

        if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
          console.log(`Copying ${dir}/ to Application Support...`);
          this.copyRecursive(srcPath, destPath);
        }
      }

      for (const file of requiredFiles) {
        const srcPath = path.join(resourcesPath, file);
        const destPath = path.join(this.baseDir, file);

        if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
          console.log(`Copying ${file} to Application Support...`);
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }

    // Check if essential files exist
    const srcDir = path.join(this.baseDir, 'src');
    if (!fs.existsSync(srcDir)) {
      throw new Error(`Server source files not found at: ${srcDir}`);
    }
  }

  /**
   * Copy directory recursively
   */
  copyRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Ensure virtual environment exists and has dependencies installed
   */
  async ensureVenv() {
    const venvPath = path.join(this.baseDir, 'venv');
    const requirementsPath = path.join(this.baseDir, 'requirements.txt');

    // If venv doesn't exist, create it
    if (!fs.existsSync(venvPath)) {
      console.log('Creating virtual environment...');

      return new Promise((resolve, reject) => {
        exec(`"${this.pythonPath}" -m venv "${venvPath}"`, (error) => {
          if (error) {
            console.error('Failed to create venv:', error);
            reject(error);
            return;
          }

          // Install requirements
          if (fs.existsSync(requirementsPath)) {
            const venvPython = path.join(venvPath, 'bin', 'python3');
            console.log('Installing requirements...');

            exec(`"${venvPython}" -m pip install -r "${requirementsPath}"`, (error2) => {
              if (error2) {
                console.error('Failed to install requirements:', error2);
                reject(error2);
                return;
              }

              console.log('Venv setup complete');
              // Update pythonPath to use venv
              this.pythonPath = venvPython;
              resolve();
            });
          } else {
            resolve();
          }
        });
      });
    } else {
      // Venv exists, use it
      const venvPython = path.join(venvPath, 'bin', 'python3');
      if (fs.existsSync(venvPython)) {
        this.pythonPath = venvPython;
        console.log(`Using existing venv: ${venvPython}`);
      }
    }
  }

  /**
   * Check if the configured port is in use.
   * @param {number} [port] - port to probe. Defaults to getPort() -
   *   evaluated lazily so a malformed PORT= in .env throws here rather
   *   than silently probing DEFAULT_PORT (three-outcome contract, see
   *   getPort()'s docstring).
   * @returns {Promise<boolean>}
   */
  async isPortInUse(port = this.getPort()) {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(false);
      });

      server.listen(port, '0.0.0.0');
    });
  }

  /**
   * Start the Python FastAPI server
   */
  async start() {
    if (this.process) {
      console.log('Server already running');
      return;
    }

    // First-run setup: Ensure server files, venv, and cloudflared exist
    try {
      await this.ensureServerFiles();
      await this.ensureVenv();
      await this.ensureCloudflared();
    } catch (error) {
      console.error('Setup failed:', error);
      this.state = 'stopped';
      throw error;
    }

    // Validate .env file has required fields
    const validation = this.validateEnvFile();
    if (!validation.isValid) {
      const errorMsg = `Configuration validation failed:\n${validation.errors.join('\n')}`;
      console.error(errorMsg);

      // Write to startup error log even if server doesn't start
      const errorLogPath = path.join(app.getPath('userData'), 'logs', 'startup-errors.log');
      try {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(errorLogPath, `\n[${timestamp}] ${errorMsg}\n`);
        console.log(`Error logged to: ${errorLogPath}`);
      } catch (logErr) {
        console.warn('Could not write to error log:', logErr.message);
      }

      this.state = 'stopped';
      throw new Error(errorMsg);
    }

    // Check if port is already in use. validateEnvFile() above already
    // confirmed getPort() resolves without throwing, so this call is safe.
    const port = this.getPort();
    const portInUse = await this.isPortInUse(port);
    if (portInUse) {
      console.log(`Port ${port} already in use, checking if it's our server...`);
      const health = await this.getHealth();
      if (health) {
        console.log('Server already running on port, adopting it');
        this.state = 'running';
        this.startTime = Date.now(); // Approximate
        this.ownedProcess = false; // We didn't spawn this — don't kill it on quit

        // Try to capture the PID of the existing process (for display only)
        try {
          exec(`lsof -ti:${port}`, (err, stdout) => {
            if (!err && stdout) {
              const pid = parseInt(stdout.trim());
              if (!isNaN(pid)) {
                console.log(`Adopted existing server process PID: ${pid}`);
                this.processPid = pid;
              }
            }
          });
        } catch (e) {
          console.warn('Could not determine PID of running server:', e.message);
        }

        return;
      } else {
        // Something that is NOT a Cloude Code server holds the port.
        //
        // We deliberately do not kill it. The holder could be anything the
        // user cares about, and silently killing a stranger's process is not
        // a decision this app gets to make.
        //
        // We also do not fall back to a free port. The port is not a private
        // detail of this process: it comes from getPort() (PORT= in .env,
        // or DEFAULT_PORT - see getPort()'s docstring), and stop.sh /
        // reset.sh / nuke.sh resolve the SAME value the SAME way, so
        // whatever this app reports here is exactly what those scripts will
        // go looking for too. Moving the listener without moving all of
        // those turns one visible failure into several invisible ones.
        //
        // So: report it. This previously logged to a console nobody reads and
        // returned, leaving the menu bar showing no error at all.
        const holder = await this.describePortHolder();
        this.state = 'stopped';
        throw new Error(
          `Port ${port} is already in use by ${holder}, which is not a ` +
            `Cloude Code server.\n\n` +
            `Cloude Code needs port ${port}. Quit that process, then choose ` +
            `Start Server from the Cloude Code menu.`
        );
      }
    }

    console.log('Starting Cloude Code server...');
    console.log(`Base directory: ${this.baseDir}`);
    console.log(`Python path: ${this.pythonPath}`);
    console.log(`Log file: ${this.logFile}`);

    // A new start clears any previous crash, so the tray shows the
    // current attempt rather than the last failure forever. A flag that
    // never clears is furniture, not a signal.
    this.lastExitUnexpected = false;
    this.stopRequested = false;
    this.state = 'starting';

    // Create log file stream
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.logStream.write(`\n\n=== Server starting at ${new Date().toISOString()} ===\n`);

    // Add bin directory to PATH so python process can find cloudflared.
    // Also prepend Homebrew bin dirs so the Python server can locate tmux
    // under Electron's launchd environment (which strips user PATH).
    // /opt/homebrew/bin = Apple Silicon, /usr/local/bin = Intel Homebrew.
    const binDir = path.join(this.baseDir, 'bin');
    const env = { ...process.env };
    env.PATH = `${binDir}:/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;

    // Inject the bind host. pydantic-settings in src/config.py is
    // case-insensitive, so plain HOST maps to settings.host which
    // uvicorn.run reads in src/main.py. Always set explicitly — never
    // rely on the .env baseline — so this is the single source of truth.
    env.HOST = this.getBindHost();
    console.log(`[spawn] HOST=${env.HOST}`);

    // Inject the app version so the Python server can stamp the web-client
    // header chip ({{VERSION}} in client/index.html). app.getVersion() reads
    // the bundle's package.json — the canonical release number. This is the
    // ONLY reliable source inside the packaged .app: package.json ships in
    // app.asar and is NOT on the filesystem the Python server runs from.
    try {
      env.CLOUDE_APP_VERSION = app.getVersion();
      console.log(`[spawn] CLOUDE_APP_VERSION=${env.CLOUDE_APP_VERSION}`);
    } catch (err) {
      console.warn('[spawn] could not resolve app version:', err.message);
    }

    this.process = spawn(this.pythonPath, ['-m', 'src.main'], {
      cwd: this.baseDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env
    });

    this.processPid = this.process.pid;
    this.ownedProcess = true; // We spawned it — we can safely kill it on quit
    this.startTime = Date.now();
    console.log(`Server process started with PID: ${this.processPid}`);

    // Log stdout and detect when server is ready
    this.process.stdout.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`[SERVER] ${output}`);

      // Write to log file
      if (this.logStream) {
        this.logStream.write(`[STDOUT] ${output}\n`);
      }

      // Check if server is ready
      if (output.includes('Application startup complete') ||
        output.includes('application_ready')) {
        this.state = 'running';
      }
    });

    // Log stderr
    this.process.stderr.on('data', (data) => {
      const output = data.toString().trim();
      console.error(`[SERVER ERROR] ${output}`);

      // Write to log file
      if (this.logStream) {
        this.logStream.write(`[STDERR] ${output}\n`);
      }

      // Also check stderr for ready signal
      if (output.includes('Application startup complete')) {
        this.state = 'running';
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`Server process exited with code ${code} and signal ${signal}`);

      // Close log stream
      if (this.logStream) {
        this.logStream.write(`\n=== Server stopped at ${new Date().toISOString()} (code: ${code}, signal: ${signal}) ===\n`);
        this.logStream.end();
        this.logStream = null;
      }

      // An exit we did not ask for is a crash, whatever the code says. A
      // uvicorn that loses its port exits non-zero; one the OOM killer takes
      // exits on a signal. Both matter to the user, and neither is
      // distinguishable from a clean stop once state collapses to 'stopped'.
      this.lastExit = { code, signal, at: Date.now() };
      this.lastExitUnexpected = !this.stopRequested;
      this.stopRequested = false;

      this.process = null;
      this.processPid = null;
      this.ownedProcess = false;
      this.state = 'stopped';
      this.startTime = null;
    });

    // Handle process errors
    this.process.on('error', (err) => {
      console.error('Failed to start server:', err);

      // Close log stream
      if (this.logStream) {
        this.logStream.write(`\n=== Server error: ${err.message} ===\n`);
        this.logStream.end();
        this.logStream = null;
      }

      // Failing to spawn at all is never something the user asked for.
      this.lastExit = { code: null, signal: null, error: err.message, at: Date.now() };
      this.lastExitUnexpected = true;
      this.stopRequested = false;

      this.process = null;
      this.processPid = null;
      this.ownedProcess = false;
      this.state = 'stopped';
      this.startTime = null;
    });

    console.log('Server process started');
  }

  /**
   * Kill process by PID
   */
  killByPid(pid, signal = 'SIGTERM') {
    return new Promise((resolve) => {
      exec(`kill -${signal === 'SIGTERM' ? '15' : '9'} ${pid}`, (error) => {
        if (error) {
          console.log(`Failed to kill PID ${pid}:`, error.message);
        }
        resolve();
      });
    });
  }

  /**
   * Human-readable description of whatever currently holds the configured
   * port.
   *
   * Exists purely to make the port-in-use error actionable. "Port 8000 is in
   * use" tells the user nothing they can do; "PID 4312 (node)" tells them
   * exactly what to quit.
   *
   * Never throws: this runs on an error path, and failing to name the holder
   * must not replace a useful error with a confusing one. If getPort()
   * itself can't determine the port, that is reported as "another process"
   * rather than crashing this diagnostic helper - the caller (start()'s
   * port-in-use branch) already has a port number of its own to report.
   *
   * @returns {Promise<string>} e.g. `PID 4312 (node)`, `PID 4312`, or the
   *   generic `another process` when lsof and ps both tell us nothing.
   */
  describePortHolder() {
    let port;
    try {
      port = this.getPort();
    } catch (err) {
      return Promise.resolve('another process');
    }
    return new Promise((resolve) => {
      exec(`lsof -ti:${port}`, (err, stdout) => {
        const pid = parseInt(String(stdout || '').trim().split('\n')[0], 10);
        if (err || Number.isNaN(pid)) {
          resolve('another process');
          return;
        }
        exec(`ps -p ${pid} -o comm=`, (psErr, psOut) => {
          const name = String(psOut || '').trim();
          // A full path is normal from ps; the basename is what the user sees
          // in Activity Monitor.
          const base = name ? name.split('/').pop() : '';
          resolve(base ? `PID ${pid} (${base})` : `PID ${pid}`);
        });
      });
    });
  }

  /**
   * Stop the server.
   *
   * Only stops servers we own (spawned). Adopted servers are left alone —
   * we don't own them, we don't kill them. Shutdown is process-signal based
   * (SIGTERM → 3s grace → SIGKILL). No HTTP shutdown call — the /api/v1/shutdown
   * endpoint now requires auth, and signaling a PID we own is strictly simpler.
   */
  async stop() {
    console.log('Stopping server...');

    // Everything from here on is a deliberate stop, so the exit handler must
    // not report it as a crash. Set BEFORE any kill is issued, because the
    // exit event can land before this function returns.
    this.stopRequested = true;
    this.lastExitUnexpected = false;

    // Adopted server: we didn't start it, we don't stop it.
    if (!this.ownedProcess) {
      console.log('Server was adopted, not owned — leaving it running.');
      // Clear our local references so menu reflects "stopped" from app's POV.
      this.processPid = null;
      this.state = 'stopped';
      this.startTime = null;
      return;
    }

    // Owned server: SIGTERM via process ref or PID, then SIGKILL after grace period.
    if (this.process && !this.process.killed) {
      console.log('Sending SIGTERM to owned server process...');
      this.process.kill('SIGTERM');

      // Give uvicorn ~3s to flush connections, then force kill.
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (this.process && !this.process.killed) {
        console.log('Server did not exit on SIGTERM, sending SIGKILL');
        this.process.kill('SIGKILL');
      }
    } else if (this.processPid) {
      // Process object lost but we have PID (edge case: app restart mid-lifecycle).
      console.log(`Sending SIGTERM to owned PID ${this.processPid}...`);
      await this.killByPid(this.processPid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.killByPid(this.processPid, 'SIGKILL');
    }

    // Close log stream
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }

    // Wait briefly for exit event to fire, then clean up state if it didn't.
    await new Promise(resolve => setTimeout(resolve, 500));

    if (!this.process) {
      this.processPid = null;
      this.ownedProcess = false;
      this.state = 'stopped';
      this.startTime = null;
    }
  }

  /**
   * Restart the server
   */
  async restart() {
    console.log('Restarting server...');
    await this.stop();

    // Wait a bit before restarting
    await new Promise(resolve => setTimeout(resolve, 3000));

    await this.start();
    console.log('Server restarted');
  }

  /**
   * Check if server is healthy and get stats
   * @returns {Promise<Object|null>} Server stats or null if unhealthy
   */
  async getHealth() {
    let port;
    try {
      port = this.getPort();
    } catch (err) {
      console.error(`[port] getHealth: ${err.message}`);
      return null;
    }

    // Probe the actual bound interface, not a hardcoded 127.0.0.1 - uvicorn
    // binds exclusively, so loopback is unreachable when the user picks a
    // specific LAN IP. But the setup lockdown can also put the server on
    // loopback while configuration names a LAN address, so both are tried.
    for (const host of this.probeHostCandidates()) {
      const base = `http://${host}:${port}`;
      let stats;
      try {
        const response = await axios.get(`${base}/api/v1/health`, { timeout: 3000 });
        stats = response.data;
      } catch (err) {
        continue;
      }

      // Read the EFFECTIVE bind from the server's own mouth rather than
      // inferring it from configuration. GET /health (the unauthenticated
      // root one, not /api/v1/health) reports what it really bound.
      try {
        const exposure = await axios.get(`${base}/health`, { timeout: 3000 });
        const bind = exposure.data && exposure.data.bind;
        this.reportedBind = bind || null;
        this.reportedSetupStatus =
          (exposure.data && exposure.data.setup_status) || null;
      } catch (err) {
        // The health probe succeeded, so the server is up; only the exposure
        // detail could not be read. Say we do not know rather than keeping a
        // stale answer that would go on being displayed as current.
        this.reportedBind = null;
        this.reportedSetupStatus = null;
      }
      return stats;
    }
    return null;
  }

  /**
   * The address the server is ACTUALLY listening on, when it has said.
   *
   * @returns {string|null} The effective host, or null when unknown. Never
   *   falls back to the configured value: reporting an aspiration as a
   *   measurement is the exact defect this method exists to prevent.
   */
  getEffectiveBindHost() {
    return (this.reportedBind && this.reportedBind.effective_host) || null;
  }

  /**
   * Whether the server is pinned to loopback because setup is unfinished.
   *
   * @returns {boolean|null} True/false when known, null when unmeasured.
   */
  isBindLockedDown() {
    if (!this.reportedBind) return null;
    return Boolean(this.reportedBind.locked_down);
  }

  /**
   * The server's setup verdict, as it reported it.
   *
   * @returns {string|null} 'complete', 'incomplete', 'undetermined', or null
   *   when the server has not been asked yet.
   */
  getSetupStatus() {
    return this.reportedSetupStatus;
  }

  /**
   * Get server uptime in seconds
   * @returns {number} Uptime in seconds
   */
  getUptime() {
    if (!this.startTime) return 0;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Get current server state
   * @returns {string} 'stopped', 'starting', or 'running'
   */
  getState() {
    return this.state;
  }

  /**
   * Check if process is running
   * @returns {boolean}
   */
  isProcessRunning() {
    // If we spawned the process ourselves, check the process object
    if (this.process && !this.process.killed) {
      return true;
    }

    // If we have a PID (either spawned or adopted), verify it's still alive
    if (this.processPid) {
      try {
        // Sending signal 0 doesn't actually send a signal, just checks if process exists
        process.kill(this.processPid, 0);
        return true;
      } catch (err) {
        if (err.code === 'ESRCH') {
          // No such process - it died
          this.processPid = null;
          return false;
        }
        // Other error (e.g., permission denied) - assume it's not running
        console.warn('Error checking process PID:', err.message);
        return false;
      }
    }

    return false;
  }

  /**
   * Validate .env file has all required fields for server startup
   * @returns {Object} Validation result with isValid flag and error details
   */
  validateEnvFile() {
    const envPath = path.join(this.baseDir, '.env');

    const result = {
      isValid: true,
      missingRequired: [],
      emptyRequired: [],
      errors: []
    };

    // Check if .env exists
    if (!fs.existsSync(envPath)) {
      result.isValid = false;
      result.errors.push('.env file not found. Run setup first.');
      return result;
    }

    // Read .env content
    const envContent = fs.readFileSync(envPath, 'utf8');

    // CRITICAL: These fields are required by Settings class (no defaults)
    const criticalFields = ['DEFAULT_WORKING_DIR', 'LOG_DIRECTORY'];

    // IMPORTANT: These fields are required for authentication
    const authFields = ['TOTP_SECRET', 'JWT_SECRET'];

    // Check critical fields
    criticalFields.forEach(field => {
      const regex = new RegExp(`^${field}=(.*)$`, 'm');
      const match = envContent.match(regex);

      if (!match) {
        result.missingRequired.push(field);
        result.isValid = false;
      } else if (!match[1] || match[1].trim() === '') {
        result.emptyRequired.push(field);
        result.isValid = false;
      }
    });

    // Check auth fields
    authFields.forEach(field => {
      const regex = new RegExp(`^${field}=(.*)$`, 'm');
      const match = envContent.match(regex);

      if (!match) {
        result.missingRequired.push(field);
        result.isValid = false;
      } else if (!match[1] || match[1].trim() === '') {
        result.emptyRequired.push(field);
        result.isValid = false;
      }
    });

    // Build error messages
    if (result.missingRequired.length > 0) {
      result.errors.push(`Missing required fields: ${result.missingRequired.join(', ')}`);
    }
    if (result.emptyRequired.length > 0) {
      result.errors.push(`Empty required fields: ${result.emptyRequired.join(', ')}`);
    }

    // PORT= is optional (DEFAULT_PORT applies when absent), but if present
    // it must be a valid port number. This is the choke point that makes
    // the three-outcome contract in getPort()'s docstring bite for the one
    // path that matters most: refusing to spawn a server whose port we
    // could not determine, instead of silently trying DEFAULT_PORT and
    // reporting success.
    try {
      this.getPort();
    } catch (err) {
      result.isValid = false;
      result.errors.push(err.message);
    }

    return result;
  }

  /**
   * Whether this instance is set up, and who says so.
   *
   * The SERVER is the authority. This asks it first and uses its answer
   * whenever it has one. The local evaluation below runs only when there is
   * no server to ask - a genuine case on a first run - and it reads the same
   * facts src/core/setup_state.py reads, guarded by an antijoin in
   * tests/test_setup_verdict_authority.node.mjs.
   *
   * This method used to be checkConfiguration(), which had its own private
   * definition of "configured" requiring CLOUDFLARE_API_TOKEN,
   * CLOUDFLARE_ZONE_ID and CLOUDFLARE_DOMAIN. Those belong to a tunnel
   * feature removed in plan v3.2, nothing writes them any more, and the
   * owner's freshly set-up install was therefore judged unconfigured
   * permanently - the menu offered "Run Setup Script" after a setup that had
   * succeeded, and no amount of re-running it could have helped.
   *
   * @returns {{status: string, source: string, reason: string,
   *   checks: Array<object>}} status is 'complete', 'incomplete' or
   *   'undetermined'. Undetermined means the question could not be answered
   *   and MUST NOT be rendered as incomplete: a stopped server is not an
   *   unconfigured one.
   */
  getSetupVerdict() {
    const local = setupVerdict.evaluateLocalSetup(this.readSetupFacts());
    const resolved = setupVerdict.resolveSetupVerdict({
      serverStatus: this.getSetupStatus(),
      local,
    });
    return { ...resolved, checks: local.checks };
  }

  /**
   * Read the raw files the setup evaluation needs.
   *
   * Kept separate from the evaluation so the decision logic stays pure and
   * node-testable without a filesystem. A read that FAILS is reported as
   * null rather than as an absent file where the difference matters: an
   * unreadable pairing sentinel is "could not tell", while a missing one is
   * "not paired yet".
   *
   * @returns {{envText: (string|null), configText: (string|null),
   *   pairedExists: (boolean|null)}} Raw facts for evaluateLocalSetup.
   */
  readSetupFacts() {
    const read = (file) => {
      try {
        return fs.readFileSync(path.join(this.baseDir, file), 'utf8');
      } catch (err) {
        return null;
      }
    };

    let pairedExists;
    try {
      pairedExists = fs.existsSync(path.join(this.baseDir, '.totp_paired'));
    } catch (err) {
      pairedExists = null;
    }

    return {
      envText: read('.env'),
      configText: read('config.json'),
      pairedExists,
    };
  }

  /**
   * Open Terminal and run setup script
   */
  openSetupScript() {
    const setupScript = path.join(this.baseDir, 'setup_auth.py');
    const pythonPath = this.pythonPath;

    // Open Terminal and run setup
    exec(`osascript -e 'tell application "Terminal" to do script "cd \\"${this.baseDir}\\" && \\"${pythonPath}\\" setup_auth.py"'`);
  }

  /**
   * Get the project root directory
   * @returns {string} Path to project root
   */
  getProjectRoot() {
    return this.baseDir;
  }
}

module.exports = ServerManager;

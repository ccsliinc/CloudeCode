const { spawn, exec } = require('child_process');
const path = require('path');
const axios = require('axios');
const { app } = require('electron');
const net = require('net');
const fs = require('fs');

class ServerManager {
  constructor() {
    this.process = null;
    this.processPid = null;
    this.logStream = null;

    // Determine base directory based on whether app is packaged
    if (app.isPackaged) {
      // In production: app.asar is at dist/mac-arm64/Cloude Code.app/Contents/Resources/app.asar
      // Need to go up to project root: Resources -> Contents -> App -> mac-arm64 -> dist -> macOS -> cloudecode (7 levels)
      const appPath = app.getAppPath(); // Points to app.asar or Resources folder
      this.baseDir = path.join(appPath, '..', '..', '..', '..', '..', '..', '..');
    } else {
      // In development: running from macOS/ folder
      this.baseDir = path.join(__dirname, '..');
    }

    this.pythonPath = path.join(this.baseDir, 'venv', 'bin', 'python3');
    this.apiUrl = 'http://localhost:8000';
    this.port = 8000;
    this.logFile = '/tmp/cloudecode-server.log';
    this.state = 'stopped'; // 'stopped', 'starting', 'running'
    this.startTime = null;
  }

  /**
   * Check if port is in use
   * @returns {Promise<boolean>}
   */
  async isPortInUse() {
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

      server.listen(this.port, '0.0.0.0');
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

    // Check if port is already in use
    const portInUse = await this.isPortInUse();
    if (portInUse) {
      console.log(`Port ${this.port} already in use, checking if it's our server...`);
      const health = await this.getHealth();
      if (health) {
        console.log('Server already running on port, adopting it');
        this.state = 'running';
        this.startTime = Date.now(); // Approximate
        return;
      } else {
        console.error(`Port ${this.port} in use by another process!`);
        return;
      }
    }

    console.log('Starting Cloude Code server...');
    console.log(`Base directory: ${this.baseDir}`);
    console.log(`Python path: ${this.pythonPath}`);
    console.log(`Log file: ${this.logFile}`);

    this.state = 'starting';

    // Create log file stream
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.logStream.write(`\n\n=== Server starting at ${new Date().toISOString()} ===\n`);

    this.process = spawn(this.pythonPath, ['-m', 'src.main'], {
      cwd: this.baseDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    this.processPid = this.process.pid;
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

      this.process = null;
      this.processPid = null;
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

      this.process = null;
      this.processPid = null;
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
   * Kill any process using port 8000
   */
  killByPort() {
    return new Promise((resolve) => {
      exec(`lsof -ti:${this.port} | xargs kill -9`, (error) => {
        if (error) {
          console.log('No process found on port', this.port);
        } else {
          console.log('Killed process on port', this.port);
        }
        resolve();
      });
    });
  }

  /**
   * Stop the server gracefully
   */
  async stop() {
    console.log('Stopping server...');

    // Try graceful shutdown via API first
    try {
      await axios.post(`${this.apiUrl}/api/v1/shutdown`, {}, {
        timeout: 2000
      });
      console.log('Sent shutdown signal to server');
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.log('API shutdown failed:', err.message);
    }

    // Kill by process reference if we have it
    if (this.process && !this.process.killed) {
      console.log('Killing server process by reference...');
      this.process.kill('SIGTERM');

      // Force kill after 3 seconds if still running
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          console.log('Force killing server process');
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }
    // Otherwise kill by PID if we have it
    else if (this.processPid) {
      console.log(`Killing server by PID ${this.processPid}...`);
      await this.killByPid(this.processPid, 'SIGTERM');

      // Wait a bit, then force kill if needed
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.killByPid(this.processPid, 'SIGKILL');
    }

    // Fallback: kill any process on port 8000
    await this.killByPort();

    // Close log stream
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }

    // Wait for process to fully exit before clearing state
    await new Promise(resolve => setTimeout(resolve, 500));

    // If process still exists, wait for exit event to clean up
    // Otherwise clean up now
    if (!this.process) {
      this.processPid = null;
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
    try {
      const response = await axios.get(`${this.apiUrl}/api/v1/health`, {
        timeout: 3000
      });
      return response.data;
    } catch (err) {
      // Server not responding
      return null;
    }
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
    return this.process !== null;
  }

  /**
   * Check if configuration is complete
   * @returns {Object} Status object with isConfigured flag and details
   */
  checkConfiguration() {
    const envPath = path.join(this.baseDir, '.env');
    const configPath = path.join(this.baseDir, 'config.json');
    const setupScriptPath = path.join(this.baseDir, 'setup_auth.py');

    const status = {
      isConfigured: true,
      missingFiles: [],
      missingEnvVars: [],
      details: []
    };

    // Check if .env exists
    if (!fs.existsSync(envPath)) {
      status.isConfigured = false;
      status.missingFiles.push('.env');
      status.details.push('.env file not found');
    } else {
      // Check required env vars
      const envContent = fs.readFileSync(envPath, 'utf8');
      const requiredVars = ['TOTP_SECRET', 'JWT_SECRET'];

      requiredVars.forEach(varName => {
        if (!envContent.includes(`${varName}=`) || envContent.includes(`${varName}=\n`) || envContent.includes(`${varName}=""\n`)) {
          status.isConfigured = false;
          status.missingEnvVars.push(varName);
        }
      });

      if (status.missingEnvVars.length > 0) {
        status.details.push(`Missing env vars: ${status.missingEnvVars.join(', ')}`);
      }
    }

    // Check if config.json exists
    if (!fs.existsSync(configPath)) {
      status.missingFiles.push('config.json');
      status.details.push('config.json not found (optional)');
    }

    // Check if setup script exists
    if (!fs.existsSync(setupScriptPath)) {
      status.details.push('setup_auth.py not found');
    }

    return status;
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
}

module.exports = ServerManager;

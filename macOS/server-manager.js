const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');
const { app } = require('electron');
const net = require('net');
const fs = require('fs');

class ServerManager {
  constructor() {
    this.process = null;
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

    this.startTime = Date.now();

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
      this.state = 'stopped';
      this.startTime = null;
    });

    console.log('Server process started');
  }

  /**
   * Stop the server gracefully
   */
  async stop() {
    if (!this.process) {
      console.log('Server not running');
      return;
    }

    console.log('Stopping server...');
    this.state = 'stopped';

    try {
      // Try graceful shutdown via API first
      await axios.post(`${this.apiUrl}/api/v1/shutdown`, {}, {
        timeout: 2000
      });
      console.log('Sent shutdown signal to server');
    } catch (err) {
      console.log('API shutdown failed, killing process:', err.message);
    }

    // Kill the process
    if (this.process) {
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.process) {
          console.log('Force killing server process');
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }

    // Close log stream
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }

    this.process = null;
    this.startTime = null;
  }

  /**
   * Restart the server
   */
  async restart() {
    console.log('Restarting server...');
    await this.stop();

    // Wait a bit before restarting
    setTimeout(() => {
      this.start();
    }, 2000);
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
}

module.exports = ServerManager;

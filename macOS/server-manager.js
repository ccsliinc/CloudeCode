const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');

class ServerManager {
  constructor() {
    this.process = null;
    this.baseDir = path.join(__dirname, '..');
    this.pythonPath = path.join(this.baseDir, 'venv', 'bin', 'python3');
    this.apiUrl = 'http://localhost:8000';
    this.isRunning = false;
    this.startTime = null;
  }

  /**
   * Start the Python FastAPI server
   */
  start() {
    if (this.process) {
      console.log('Server already running');
      return;
    }

    console.log('Starting Cloude Code server...');
    console.log(`Base directory: ${this.baseDir}`);
    console.log(`Python path: ${this.pythonPath}`);

    this.process = spawn(this.pythonPath, ['-m', 'src.main'], {
      cwd: this.baseDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    this.startTime = Date.now();
    this.isRunning = true;

    // Log stdout
    this.process.stdout.on('data', (data) => {
      console.log(`[SERVER] ${data.toString().trim()}`);
    });

    // Log stderr
    this.process.stderr.on('data', (data) => {
      console.error(`[SERVER ERROR] ${data.toString().trim()}`);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`Server process exited with code ${code} and signal ${signal}`);
      this.process = null;
      this.isRunning = false;
      this.startTime = null;
    });

    // Handle process errors
    this.process.on('error', (err) => {
      console.error('Failed to start server:', err);
      this.process = null;
      this.isRunning = false;
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

    this.process = null;
    this.isRunning = false;
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
   * Check if process is running
   * @returns {boolean}
   */
  isProcessRunning() {
    return this.process !== null && this.isRunning;
  }
}

module.exports = ServerManager;

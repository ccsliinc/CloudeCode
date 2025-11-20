const { app, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const ServerManager = require('./server-manager');
const LaunchAgentInstaller = require('./launchagent-installer');

let tray = null;
let serverManager = null;
let launchAgentInstaller = null;
let statsUpdateInterval = null;
let currentStats = null;

/**
 * Show About dialog with app info and GitHub link
 */
function showAboutDialog() {
  const { BrowserWindow } = require('electron');

  // Create a small modal window
  const aboutWindow = new BrowserWindow({
    width: 500,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Get the icon path and convert to data URL for reliable display
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'AppIcon-1024.png')
    : path.join(__dirname, 'assets', 'AppIcon-1024.png');

  // Load icon and convert to data URL
  const iconImage = nativeImage.createFromPath(iconPath);
  const iconDataUrl = iconImage.toDataURL();

  const currentYear = new Date().getFullYear();
  const appVersion = 'v0.1';

  // HTML content for the about dialog
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0;
          padding: 40px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
          background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
          color: #ffffff;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          box-sizing: border-box;
        }
        .icon {
          width: 128px;
          height: 128px;
          margin-bottom: 20px;
          border-radius: 20px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }
        h1 {
          margin: 0 0 10px 0;
          font-size: 28px;
          font-weight: 600;
          color: #CC785C;
        }
        .tagline {
          margin: 0 0 30px 0;
          font-size: 16px;
          color: #999;
          text-align: center;
          max-width: 400px;
          line-height: 1.5;
        }
        .github-btn {
          padding: 12px 30px;
          background: #CC785C;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
          box-shadow: 0 4px 12px rgba(204, 120, 92, 0.3);
        }
        .github-btn:hover {
          transform: translateY(-2px);
          background: #D88770;
          box-shadow: 0 6px 20px rgba(204, 120, 92, 0.4);
        }
        .github-btn:active {
          transform: translateY(0);
        }
        .copyright {
          margin-top: 30px;
          font-size: 12px;
          color: #666;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <img src="${iconDataUrl}" class="icon" />
      <h1>☁️ Cloude Code <span style="font-size: 16px; color: #666; font-weight: 400;">${appVersion}</span></h1>
      <p class="tagline">
        Your AI coding sidekick in the menu bar.<br/>
        Command Claude from anywhere, build anywhere.
      </p>
      <button class="github-btn" onclick="openGitHub()">View on GitHub</button>
      <div class="copyright">
        Copyright © ${currentYear} Psyance, LLC. All rights reserved.
      </div>

      <script>
        function openGitHub() {
          require('electron').shell.openExternal('https://github.com/Adoom666/CloudeCode');
        }
      </script>
    </body>
    </html>
  `;

  aboutWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
  });

  // Remove menu bar from the window
  aboutWindow.setMenu(null);
}

// Prevent app from quitting when all windows are closed (menu bar app behavior)
app.on('window-all-closed', () => {
  // Don't quit
});

app.whenReady().then(async () => {
  console.log('Cloude Code menu bar app starting...');

  // Initialize components
  serverManager = new ServerManager();
  launchAgentInstaller = new LaunchAgentInstaller();

  // Create tray icon
  createTray();

  // Start server automatically
  await serverManager.start();

  // Force immediate health check to sync state before first menu update
  const health = await serverManager.getHealth();
  if (health && serverManager.getState() !== 'running') {
    console.log('Initial health check succeeded, marking as running');
    serverManager.state = 'running';
    if (!serverManager.startTime) {
      serverManager.startTime = Date.now();
    }
  }

  // Update menu with correct state
  updateMenu();

  // Start polling for stats
  startStatsPolling();

  console.log('App ready!');
});

/**
 * Create the menu bar tray icon
 */
function createTray() {
  // Try to load icon, fall back to default if not found
  let iconPath = path.join(__dirname, 'assets', 'iconTemplate.png');
  let icon;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn('Icon file not found, using default');
      icon = nativeImage.createEmpty();
    }
    icon.setTemplateImage(true); // Make it adapt to dark/light mode
  } catch (err) {
    console.error('Error loading icon:', err);
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Cloude Code');

  // Build initial menu
  updateMenu();
}

/**
 * Build and update the tray menu
 */
function updateMenu() {
  const state = serverManager.getState();
  const health = currentStats;

  const sessionName = health?.session_name || 'None';
  const tunnelCount = health?.tunnel_count || 0;

  // Check configuration status
  const configStatus = serverManager.checkConfiguration();
  const configText = configStatus.isConfigured
    ? '✓ Configuration: OK'
    : '⚠ Configuration: Setup Required';

  let statusText, statusIcon;
  switch (state) {
    case 'running':
      statusText = '● Server: Running';
      statusIcon = '●';
      break;
    case 'starting':
      statusText = '◐ Server: Starting...';
      statusIcon = '◐';
      break;
    case 'stopped':
    default:
      statusText = '○ Server: Stopped';
      statusIcon = '○';
      break;
  }

  const isRunning = state === 'running';
  const isStartingOrRunning = state === 'starting' || state === 'running';
  const canStart = state === 'stopped';
  const canStop = state === 'running' || state === 'starting';

  // Build menu items array
  const menuItems = [];

  // Only show setup script option if config is not complete
  if (!configStatus.isConfigured) {
    menuItems.push({
      label: '⚠️  Run Setup Script',
      click: () => {
        serverManager.openSetupScript();
      }
    });
  }

  // Status items (always shown)
  menuItems.push(
    {
      label: statusText,
      enabled: false
    },
    {
      label: `Session: ${sessionName}`,
      enabled: false
    },
    {
      label: `Tunnels: ${tunnelCount}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Terminal Logs',
      click: () => {
        const { exec } = require('child_process');
        const fs = require('fs');
        const logPath = serverManager.logFile;

        // Check if log file exists (it only exists if app spawned the server)
        if (fs.existsSync(logPath)) {
          // Open Terminal and tail the server logs
          exec(`osascript -e 'tell application "Terminal" to do script "tail -f \\"${logPath}\\""'`);
        } else {
          // Server was adopted, logs not captured by app
          const { dialog } = require('electron');
          dialog.showMessageBox({
            type: 'info',
            title: 'Logs Not Available',
            message: 'Server logs not available',
            detail: 'The server was already running when the app started, so logs were not captured. Restart the server from the app to enable log capture.'
          });
        }
      },
      enabled: isStartingOrRunning
    },
    {
      label: 'Open in Browser',
      click: () => {
        shell.openExternal('http://localhost:8000');
      },
      enabled: isRunning
    },
    { type: 'separator' },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Restart Server',
          click: async () => {
            await serverManager.restart();
            updateMenu();
            setTimeout(updateMenu, 2500);
          },
          enabled: isRunning
        },
        {
          label: canStart ? 'Start Server' : 'Stop Server',
          click: async () => {
            if (canStart) {
              await serverManager.start();
            } else {
              await serverManager.stop();
            }
            updateMenu();
            setTimeout(updateMenu, 500);
          },
          enabled: canStart || canStop
        },
        { type: 'separator' },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          checked: launchAgentInstaller.isEnabled(),
          click: () => {
            const appPath = app.getPath('exe');
            launchAgentInstaller.toggle(appPath);
            setTimeout(updateMenu, 100);
          }
        },
        {
          label: 'Show QR for TOTP',
          click: () => {
            const fs = require('fs');
            const qrPath = path.join(serverManager.getProjectRoot(), 'totp-qr.png');

            if (fs.existsSync(qrPath)) {
              // Open QR code image with default viewer
              shell.openPath(qrPath).then((error) => {
                if (error) {
                  const { dialog } = require('electron');
                  dialog.showMessageBox({
                    type: 'error',
                    title: 'Error Opening QR Code',
                    message: 'Could not open QR code image',
                    detail: error
                  });
                }
              });
            } else {
              const { dialog } = require('electron');
              dialog.showMessageBox({
                type: 'info',
                title: 'QR Code Not Found',
                message: 'TOTP QR code not found',
                detail: `QR code image does not exist at: ${qrPath}\n\nRun setup_auth.py to generate it.`
              });
            }
          }
        },
        {
          label: 'Edit Config',
          click: () => {
            const { exec } = require('child_process');
            const configPath = path.join(serverManager.getProjectRoot(), 'config.json');
            // Open Finder and select the config.json file
            exec(`open -R "${configPath}"`);
          }
        },
        { type: 'separator' },
        {
          label: 'Uninstall',
          submenu: [
            {
              label: '☢️  Nuke it from Orbit!',
              click: async () => {
                const { dialog } = require('electron');

                // Show confirmation dialog
                const result = await dialog.showMessageBox({
                  type: 'warning',
                  title: 'Nuke it from Orbit!',
                  message: 'Complete System Reset',
                  detail:
                    'This will completely remove ALL Cloude Code configuration:\n\n' +
                    '✗ Cloudflare tunnel will be DELETED\n' +
                    '✗ All DNS records will be DELETED\n' +
                    '✗ All local configuration files\n' +
                    '✗ Python virtual environment\n' +
                    '✗ All logs and temporary files\n' +
                    '✗ Cloudflared authentication\n' +
                    '✗ macOS app settings\n\n' +
                    'You will need to run setup.sh again to use Cloude Code.\n\n' +
                    'Are you ABSOLUTELY SURE?',
                  buttons: ['Cancel', 'NUKE IT'],
                  defaultId: 0,
                  cancelId: 0
                });

                if (result.response === 1) {
                  console.log('Nuking system...');

                  // Stop server first
                  await serverManager.stop();

                  // Stop stats polling
                  if (statsUpdateInterval) {
                    clearTimeout(statsUpdateInterval);
                  }

                  // Run nuke.sh script
                  const { exec } = require('child_process');
                  const fs = require('fs');
                  const projectRoot = serverManager.getProjectRoot();
                  const nukeScript = path.join(projectRoot, 'nuke.sh');
                  const nukeLogFile = '/tmp/cloudecode-nuke.log';

                  // Create log stream
                  const logStream = fs.createWriteStream(nukeLogFile, { flags: 'a' });
                  const timestamp = new Date().toISOString();

                  logStream.write(`\n\n=== Nuke started at ${timestamp} ===\n`);
                  logStream.write(`Script path: ${nukeScript}\n`);
                  logStream.write(`Working directory: ${projectRoot}\n`);
                  logStream.write(`Command: "${nukeScript}" --skip-confirm\n\n`);

                  exec(`"${nukeScript}" --skip-confirm`, { cwd: projectRoot }, (error, stdout, stderr) => {
                    // Log all output
                    logStream.write(`STDOUT:\n${stdout}\n\n`);
                    if (stderr) {
                      logStream.write(`STDERR:\n${stderr}\n\n`);
                    }
                    logStream.write(`Exit code: ${error ? error.code : 0}\n`);

                    // Verify cleanup actually happened
                    const envPath = path.join(projectRoot, '.env');
                    const venvPath = path.join(projectRoot, 'venv');
                    const configPath = path.join(projectRoot, 'config.json');

                    const envExists = fs.existsSync(envPath);
                    const venvExists = fs.existsSync(venvPath);
                    const configExists = fs.existsSync(configPath);

                    logStream.write(`\nCleanup verification:\n`);
                    logStream.write(`  .env exists: ${envExists}\n`);
                    logStream.write(`  venv exists: ${venvExists}\n`);
                    logStream.write(`  config.json exists: ${configExists}\n`);

                    const cleanupSucceeded = !envExists && !venvExists;
                    logStream.write(`  Cleanup succeeded: ${cleanupSucceeded}\n`);
                    logStream.write(`=== Nuke finished at ${new Date().toISOString()} ===\n`);
                    logStream.end();

                    if (error) {
                      console.error('Nuke failed:', error);
                      dialog.showErrorBox(
                        'Nuke Failed',
                        `Failed to complete system reset:\n\n${error.message}\n\nCheck logs at: ${nukeLogFile}`
                      );
                    } else if (!cleanupSucceeded) {
                      // Script exited successfully but cleanup didn't happen
                      console.error('Nuke script succeeded but cleanup verification failed');
                      dialog.showErrorBox(
                        'Nuke Incomplete',
                        `Script completed but cleanup verification failed.\n\nFiles still exist:\n${envExists ? '  • .env\n' : ''}${venvExists ? '  • venv/\n' : ''}\n\nCheck logs at: ${nukeLogFile}`
                      );
                    } else {
                      console.log('Nuke completed successfully');
                      console.log('Nuke output:', stdout);
                      if (stderr) console.error('Nuke stderr:', stderr);

                      // Show success and quit
                      dialog.showMessageBox({
                        type: 'info',
                        title: 'System Reset Complete',
                        message: 'Cloude Code has been completely removed.',
                        detail: `All configuration has been deleted.\n\nLogs saved to: ${nukeLogFile}\n\nRun ./setup.sh to configure again.\n\nThe app will now quit.`,
                        buttons: ['OK']
                      }).then(() => {
                        app.quit();
                      });
                    }
                  });
                }
              }
            }
          ]
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'About Cloude Code',
      click: () => {
        showAboutDialog();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Cloude Code',
      click: async () => {
        console.log('Quitting app...');

        // Stop stats polling
        if (statsUpdateInterval) {
          clearTimeout(statsUpdateInterval);
        }

        // Stop server
        await serverManager.stop();

        // Quit app
        app.quit();
      }
    }
  );

  const menu = Menu.buildFromTemplate(menuItems);

  tray.setContextMenu(menu);
}

/**
 * Start polling server for stats updates
 */
function startStatsPolling() {
  let pollInterval = 5000; // Default 5 seconds
  let fastPollCount = 0;
  const maxFastPolls = 12; // Poll fast for ~1 minute during startup

  const poll = async () => {
    const state = serverManager.getState();

    // Poll faster during startup
    if (state === 'starting' && fastPollCount < maxFastPolls) {
      pollInterval = 2000; // 2 seconds
      fastPollCount++;
    } else {
      pollInterval = 5000; // 5 seconds
      fastPollCount = 0;
    }

    // Check if server should be running (either we started it or adopted it)
    if (state === 'running' || state === 'starting' || serverManager.isProcessRunning()) {
      const health = await serverManager.getHealth();
      if (health) {
        currentStats = health;
        // If we got health response, mark as running
        if (state !== 'running') {
          console.log('Health check succeeded, marking as running');
          serverManager.state = 'running';
          if (!serverManager.startTime) {
            serverManager.startTime = Date.now();
          }
        }
        updateMenu();
      } else {
        // Server process running but API not responding - mark as "starting"
        if (serverManager.isProcessRunning()) {
          if (state !== 'starting') {
            console.log('Process running but health check failed, marking as starting');
            serverManager.state = 'starting';
          }
        } else {
          // No process and no health - mark as stopped
          if (state !== 'stopped') {
            console.log('No process detected and health check failed, marking as stopped');
            serverManager.state = 'stopped';
            serverManager.startTime = null;
          }
        }
        currentStats = null;
        updateMenu();
      }
    } else {
      currentStats = null;
      if (state !== 'stopped') {
        serverManager.state = 'stopped';
        serverManager.startTime = null;
      }
      updateMenu();
    }

    // Schedule next poll with dynamic interval
    if (statsUpdateInterval) {
      clearTimeout(statsUpdateInterval);
    }
    statsUpdateInterval = setTimeout(poll, pollInterval);
  };

  // Start polling immediately - status will naturally transition from
  // "Stopped" -> "Starting" -> "Running" based on health checks
  poll();
}

/**
 * Handle app quit
 */
app.on('before-quit', async () => {
  console.log('App quitting...');

  if (statsUpdateInterval) {
    clearTimeout(statsUpdateInterval);
  }

  if (serverManager) {
    await serverManager.stop();
  }
});

/**
 * Handle app activation (macOS specific)
 */
app.on('activate', () => {
  // On macOS, clicking dock icon should show menu
  if (tray) {
    tray.popUpContextMenu();
  }
});

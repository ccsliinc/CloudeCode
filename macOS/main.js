const { app, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const ServerManager = require('./server-manager');
const LaunchAgentInstaller = require('./launchagent-installer');

let tray = null;
let serverManager = null;
let launchAgentInstaller = null;
let statsUpdateInterval = null;
let currentStats = null;

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
  const canStart = state === 'stopped';
  const canStop = state === 'running' || state === 'starting';

  const menu = Menu.buildFromTemplate([
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
      label: 'Open Terminal',
      click: () => {
        shell.openExternal('http://localhost:8000');
      },
      enabled: isRunning
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
  ]);

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

    if (serverManager.isProcessRunning()) {
      const health = await serverManager.getHealth();
      if (health) {
        currentStats = health;
        updateMenu();
      } else {
        // Server process running but API not responding
        currentStats = null;
        updateMenu();
      }
    } else {
      currentStats = null;
      updateMenu();
    }

    // Schedule next poll with dynamic interval
    if (statsUpdateInterval) {
      clearTimeout(statsUpdateInterval);
    }
    statsUpdateInterval = setTimeout(poll, pollInterval);
  };

  // Do initial check after 2 seconds
  setTimeout(poll, 2000);
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

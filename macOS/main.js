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

app.whenReady().then(() => {
  console.log('Cloude Code menu bar app starting...');

  // Initialize components
  serverManager = new ServerManager();
  launchAgentInstaller = new LaunchAgentInstaller();

  // Create tray icon
  createTray();

  // Start server automatically
  serverManager.start();

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
  const isRunning = serverManager.isProcessRunning();
  const health = currentStats;

  const sessionName = health?.session_name || 'None';
  const tunnelCount = health?.tunnel_count || 0;
  const statusText = isRunning ? '● Server: Running' : '○ Server: Stopped';

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
        setTimeout(updateMenu, 500);
      },
      enabled: isRunning
    },
    {
      label: isRunning ? 'Stop Server' : 'Start Server',
      click: async () => {
        if (isRunning) {
          await serverManager.stop();
        } else {
          serverManager.start();
        }
        setTimeout(updateMenu, 500);
      }
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
          clearInterval(statsUpdateInterval);
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
  // Poll every 5 seconds
  statsUpdateInterval = setInterval(async () => {
    if (serverManager.isProcessRunning()) {
      const health = await serverManager.getHealth();
      if (health) {
        currentStats = health;
        updateMenu();
      } else {
        // Server process running but API not responding
        currentStats = null;
      }
    } else {
      currentStats = null;
      updateMenu();
    }
  }, 5000);

  // Do initial check after 3 seconds (give server time to start)
  setTimeout(async () => {
    const health = await serverManager.getHealth();
    if (health) {
      currentStats = health;
      updateMenu();
    }
  }, 3000);
}

/**
 * Handle app quit
 */
app.on('before-quit', async () => {
  console.log('App quitting...');

  if (statsUpdateInterval) {
    clearInterval(statsUpdateInterval);
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

// Electron shell: a window onto the daemon's Harbor Master's Glass.
// The daemon serves the actual UI, so this stays a thin, honest wrapper —
// same view in a browser tab if you'd rather not launch Electron at all.

import { app, BrowserWindow, shell } from 'electron';

const DAEMON_URL = process.env.PORTCALL_URL || 'http://127.0.0.1:4747';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'PortCall — Harbor Master’s Glass',
    backgroundColor: '#0a121d',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(DAEMON_URL).catch(() => {
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="background:#0a121d;color:#e8dcc3;font-family:Georgia,serif;display:grid;place-items:center;height:100vh">
             <div style="text-align:center">
               <div style="font-size:3rem">⚓</div>
               <h2>The harbor is closed.</h2>
               <p>Could not reach <code>${DAEMON_URL}</code>.<br>Start the daemon first: <code>node src/daemon.ts</code></p>
             </div>
           </body>`,
        ),
    );
  });

  // External links open in the real browser, not in the glass.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

void app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

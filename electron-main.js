"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function createWindow() {
  const window = new BrowserWindow({
    title: "时序工坊",
    width: 1500,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

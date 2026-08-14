const { app, BrowserWindow, ipcMain, dialog, net, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { autoUpdater } = require("electron-updater");

const APP_ID = "com.ziracai.rio.studio.designers";
const APP_ICON_PNG = path.join(__dirname, "build", "icon.png");
const APP_ICON_ICO = path.join(__dirname, "build", "icon.ico");

// ── Auto-Updater Configuration ──
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;
autoUpdater.allowPrerelease = false;

// Disable differential downloads for simpler setup
autoUpdater.differentialPackage = false;

function resolveAppIcon() {
    for (const iconPath of [APP_ICON_PNG, APP_ICON_ICO]) {
        if (!fs.existsSync(iconPath)) continue;
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) return img;
    }
    return undefined;
}
const PING_HOST = "connectivitycheck.gstatic.com";
const PING_PATH = "/generate_204";
const POLL_FAST_MS = 200;
const POLL_SLOW_MS = 650;
const PING_TIMEOUT_MS = 900;

let mainWindow = null;
let networkPollTimer = null;
let pingInFlight = false;
let lastNetworkStatus = { osOnline: true, internetReachable: false, connected: false, pingMs: null };

function pingInternet() {
    if (pingInFlight) return Promise.resolve(lastNetworkStatus.internetReachable);
    pingInFlight = true;
    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: PING_HOST,
                path: PING_PATH + "?" + Date.now(),
                method: "HEAD",
                timeout: PING_TIMEOUT_MS
            },
            (res) => {
                res.resume();
                pingInFlight = false;
                resolve(res.statusCode === 204 || (res.statusCode >= 200 && res.statusCode < 400));
            }
        );
        req.on("error", () => {
            pingInFlight = false;
            resolve(false);
        });
        req.on("timeout", () => {
            req.destroy();
            pingInFlight = false;
            resolve(false);
        });
        req.end();
    });
}

async function readNetworkStatus() {
    const osOnline = net.isOnline();
    if (!osOnline) {
        return { osOnline: false, internetReachable: false, connected: false, pingMs: null };
    }
    const start = Date.now();
    const internetReachable = await pingInternet();
    const pingMs = internetReachable ? Date.now() - start : null;
    return {
        osOnline: true,
        internetReachable,
        connected: internetReachable,
        pingMs
    };
}

function pushNetworkStatus(status) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("net:status-changed", status);
}

async function pollNetworkStatus(forcePush = false) {
    const status = await readNetworkStatus();
    const changed =
        status.osOnline !== lastNetworkStatus.osOnline ||
        status.internetReachable !== lastNetworkStatus.internetReachable;

    lastNetworkStatus = status;

    if (forcePush || changed) pushNetworkStatus(status);
    return status;
}

function startNetworkPolling() {
    if (networkPollTimer) clearTimeout(networkPollTimer);

    const tick = async (forcePush = false) => {
        await pollNetworkStatus(forcePush);
        const delay = lastNetworkStatus.connected ? POLL_SLOW_MS : POLL_FAST_MS;
        networkPollTimer = setTimeout(() => tick(false), delay);
    };

    tick(true);
}

function stopNetworkPolling() {
    if (networkPollTimer) {
        clearTimeout(networkPollTimer);
        networkPollTimer = null;
    }
    pingInFlight = false;
}

function createWindow() {
    const winIcon = resolveAppIcon();
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        title: "Rio Studio Designers",
        icon: winIcon,
        autoHideMenuBar: true,
        backgroundColor: "#000000",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, "preload.js")
        }
    });
    mainWindow.loadFile("index.html");
    mainWindow.webContents.on("did-finish-load", () => startNetworkPolling());
    mainWindow.on("closed", () => {
        mainWindow = null;
        stopNetworkPolling();
    });
}

ipcMain.handle("net:getStatus", () => readNetworkStatus());

// ── PDF Save via Electron's native Chromium PDF engine ──
ipcMain.handle("save-pdf", async (event, htmlContent) => {
    const tempPath = path.join(app.getPath("temp"), "rio_pdf_temp.html");
    fs.writeFileSync(tempPath, htmlContent, "utf8");

    const pdfWin = new BrowserWindow({
        width: 794,
        height: 1123,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    await pdfWin.loadFile(tempPath);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const pdfData = await pdfWin.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        margins: { marginType: "custom", top: 0, bottom: 0, left: 0, right: 0 }
    });

    const defaultName = `Rio_Studio_Summary_${new Date().toISOString().split("T")[0]}.pdf`;
    const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath("desktop"), defaultName),
        filters: [{ name: "PDF Files", extensions: ["pdf"] }]
    });

    pdfWin.destroy();
    try {
        fs.unlinkSync(tempPath);
    } catch (e) {
        /* ignore */
    }

    if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, pdfData);
        return { success: true, path: result.filePath };
    }
    return { success: false };
});

// ── Auto-Updater IPC Handlers ──
ipcMain.handle("check-for-updates", async () => {
    try {
        const info = await autoUpdater.checkForUpdates();
        return { success: true, hasUpdate: !!info?.updateInfo };
    } catch (err) {
        console.error("[AutoUpdater] Check failed:", err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle("restart-and-install", () => {
    autoUpdater.quitAndInstall(false, true);
});

// ── Auto-Updater Event Listeners ──
autoUpdater.on("checking-for-update", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-checking");
    }
});

autoUpdater.on("update-available", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-available", {
            version: info?.version || "latest"
        });
    }
});

autoUpdater.on("update-not-available", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-not-available");
    }
});

autoUpdater.on("download-progress", (progressObj) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-download-progress", {
            percent: progressObj.percent,
            transferred: progressObj.transferred,
            total: progressObj.total,
            bytesPerSecond: progressObj.bytesPerSecond
        });
    }
});

autoUpdater.on("update-downloaded", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-downloaded", {
            version: info?.version || "latest"
        });
    }
});

autoUpdater.on("error", (err) => {
    console.error("[AutoUpdater] Error:", err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-error", {
            message: err.message
        });
    }
});

app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    else {
        const appIcon = resolveAppIcon();
        if (appIcon) app.setIcon(appIcon);
    }
    createWindow();
    
    // Start checking for updates after a short delay
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch((err) => {
            console.error("[AutoUpdater] Initial check failed:", err.message);
        });
    }, 1500);
});

app.on("window-all-closed", () => {
    stopNetworkPolling();
    if (process.platform !== "darwin") app.quit();
});

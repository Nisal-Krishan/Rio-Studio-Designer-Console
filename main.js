const { app, BrowserWindow, ipcMain, dialog, net, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");

const APP_ID = "com.ziracai.rio.studio.designers";
const APP_ICON_PNG = path.join(__dirname, "build", "icon.png");
const APP_ICON_ICO = path.join(__dirname, "build", "icon.ico");

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
        show: false,
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

    mainWindow.once("ready-to-show", () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.loadFile("index.html").catch((err) => {
        dialog.showErrorBox("Rio Studio Designers", "Failed to load app: " + (err?.message || err));
        app.quit();
    });

    mainWindow.webContents.on("did-finish-load", () => startNetworkPolling());
    mainWindow.on("closed", () => {
        mainWindow = null;
        stopNetworkPolling();
    });
}

ipcMain.handle("net:getStatus", () => readNetworkStatus());

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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        if (process.platform === "win32") app.setAppUserModelId(APP_ID);
        else {
            const appIcon = resolveAppIcon();
            if (appIcon) app.setIcon(appIcon);
        }
        createWindow();
    });
}

app.on("window-all-closed", () => {
    stopNetworkPolling();
    if (process.platform !== "darwin") app.quit();
});

process.on("uncaughtException", (err) => {
    console.error("[Main] Uncaught exception:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("[Main] Unhandled rejection:", err);
});

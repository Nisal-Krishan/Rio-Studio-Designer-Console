const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rioNet", {
    getStatus: () => ipcRenderer.invoke("net:getStatus"),
    onStatusChange: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, status) => callback(status);
        ipcRenderer.on("net:status-changed", handler);
        return () => ipcRenderer.removeListener("net:status-changed", handler);
    }
});

// ── Auto-Updater IPC Bridge ──
contextBridge.exposeInMainWorld("rioUpdater", {
    checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
    restartAndInstall: () => ipcRenderer.invoke("restart-and-install"),
    onUpdateChecking: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = () => callback();
        ipcRenderer.on("update-checking", handler);
        return () => ipcRenderer.removeListener("update-checking", handler);
    },
    onUpdateAvailable: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, info) => callback(info);
        ipcRenderer.on("update-available", handler);
        return () => ipcRenderer.removeListener("update-available", handler);
    },
    onUpdateNotAvailable: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = () => callback();
        ipcRenderer.on("update-not-available", handler);
        return () => ipcRenderer.removeListener("update-not-available", handler);
    },
    onUpdateDownloadProgress: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, progress) => callback(progress);
        ipcRenderer.on("update-download-progress", handler);
        return () => ipcRenderer.removeListener("update-download-progress", handler);
    },
    onUpdateDownloaded: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, info) => callback(info);
        ipcRenderer.on("update-downloaded", handler);
        return () => ipcRenderer.removeListener("update-downloaded", handler);
    },
    onUpdateError: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, error) => callback(error);
        ipcRenderer.on("update-error", handler);
        return () => ipcRenderer.removeListener("update-error", handler);
    }
});

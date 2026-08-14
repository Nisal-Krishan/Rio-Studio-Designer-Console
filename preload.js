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

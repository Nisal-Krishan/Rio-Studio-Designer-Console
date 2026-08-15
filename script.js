/* Rio Studio Designers v3.7.0 */

const APP_VERSION = "3.7.0";
const PATCH_DISMISS_KEY = "rio_patch_hide_" + APP_VERSION;

const firebaseConfig = {
    apiKey: "AIzaSyDVcCDhC5zFgmPObejWWNAqD5z3jrAI5QY",
    authDomain: "rio-studio-d.firebaseapp.com",
    projectId: "rio-studio-d",
    storageBucket: "rio-studio-d.firebasestorage.app",
    messagingSenderId: "127183980250",
    appId: "1:127183980250:web:1b90d1a3f75be1a2dcc7e3"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const LS = {
    USERS: "rio_users_cache",
    BILLS: "rio_bills_cache",
    PENDING_BILLS: "rio_pending_bills",
    PENDING_USERS: "rio_pending_users",
    PENDING_BILL_OPS: "rio_pending_bill_ops",
    DELETED_BILLS: "rio_deleted_bills",
    SESSION: "rio_session",
    DESIGNER_CAPS: "rio_designer_caps"
};

const DEV_USER = "Nisal_Krishan";
const DEV_PASS = "9987";
const SESSION_MS = 24 * 60 * 60 * 1000;
const SESSION_ONLINE_MS = 90000;
const SESSION_IDLE_MS = 180000;
const SESSION_HEARTBEAT_MS = 20000;
const PRESENCE_UI_MS = 15000;
const FIRESTORE_STORAGE_LIMIT = 100 * 1024 * 1024;
const LOCAL_STORAGE_LIMIT = 25 * 1024 * 1024;
const STORAGE_WARN_PERCENT = 80;
let storageDashboardInterval = null;
const MONITOR_LOG_MAX = 100;
const MONITOR_POLL_MS = 2000;
let monitorLog = [];
let monitorBoardActive = false;
let lastPingMs = null;
let lastSyncTime = null;
let monitorClockInterval = null;
const appStartTime = Date.now();

let currentUser = null;
let adminBillsUnsub = null, adminUsersUnsub = null, designerBillsUnsub = null;
let devBillsUnsub = null, devUsersUnsub = null, sessionsUnsub = null;
let networkMonitorUnsub = null, remoteSessionUnsub = null, globalLogoutUnsub = null;
let presenceUiInterval = null;
let firebaseReady = false, isOnline = false, isSyncing = false;
let firestoreFromCache = true, sessionCheckInterval = null;
let serverConnected = false, loginConnectionState = "checking", networkInitDone = false;
let osOnline = true, internetReachable = false;
let networkUiFrame = null, autoSyncTimer = null;
let cachedBills = [], cachedUsers = [];
let activeSessionsMap = {}, devSelectedBills = new Set(), devDisplayedBills = [];

const loadingOverlay = document.getElementById("loadingOverlay");
const loginSection = document.getElementById("loginSection");
const adminSection = document.getElementById("adminSection");
const designerSection = document.getElementById("designerSection");
const developerSection = document.getElementById("developerSection");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");
const connectionStatus = document.getElementById("connectionStatus");

function loadLS(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function saveLS(key, d) { localStorage.setItem(key, JSON.stringify(d)); }
function getPendingBills() { return loadLS(LS.PENDING_BILLS, []); }
function savePendingBills(l) { saveLS(LS.PENDING_BILLS, l); }
function getPendingUsers() { return loadLS(LS.PENDING_USERS, []); }
function savePendingUsers(l) { saveLS(LS.PENDING_USERS, l); }
function getPendingBillOps() { return loadLS(LS.PENDING_BILL_OPS, []); }
function savePendingBillOps(l) { saveLS(LS.PENDING_BILL_OPS, l); }
function getDeletedBillIds() { return loadLS(LS.DELETED_BILLS, []); }
function saveDeletedBillIds(l) { saveLS(LS.DELETED_BILLS, l); }
function getCachedUsers() { return loadLS(LS.USERS, []); }
function cacheUsers(u) { saveLS(LS.USERS, u); cachedUsers = u; }
function getCachedBills() { return loadLS(LS.BILLS, []); }
function cacheBills(b) { saveLS(LS.BILLS, b); cachedBills = b; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function withTimeout(p, ms, msg) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || "Timed out")), ms))]);
}
async function retryOperation(op, retries = 3, delay = 1000, timeout = 15000) {
    let last;
    for (let i = 0; i < retries; i++) {
        try { return await withTimeout(op(), timeout, "Connection timed out"); }
        catch (e) { last = e; if (i < retries - 1) await sleep(delay * (i + 1)); }
    }
    throw last;
}
function formatMoney(n) { return parseFloat(n || 0).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function escAttr(s) { return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function billDesignCharge(b) { const n = parseFloat(b?.designCharge); return isNaN(n) || n < 0 ? 0 : n; }
function billLineTotal(b) { return parseFloat(b?.price || 0) + billDesignCharge(b); }
function normalizeBillInput(description, designChargeRaw) {
    const descriptionVal = String(description || "").trim();
    let designCharge = designChargeRaw === "" || designChargeRaw == null ? 0 : parseFloat(designChargeRaw);
    if (isNaN(designCharge) || designCharge < 0) designCharge = 0;
    return { description: descriptionVal, designCharge };
}
function billFingerprint(b) {
    return `${b.username}|${b.date}|${b.billNo}|${b.price}|${b.description || ""}|${billDesignCharge(b)}`;
}
function updateBillLinePreview() {
    const el = document.getElementById("billLineTotalPreview");
    if (!el) return;
    const price = parseFloat(document.getElementById("billPrice")?.value || 0) || 0;
    const charge = parseFloat(document.getElementById("billDesignCharge")?.value || 0) || 0;
    el.textContent = "Rs. " + formatMoney(price + charge);
}
function showToast(msg, err = false) {
    document.querySelector(".toast")?.remove();
    const t = document.createElement("div"); t.className = "toast" + (err ? " error" : ""); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
}
function showLoginError(msg) { loginError.textContent = msg; loginError.classList.add("visible"); }
function hideLoginError() { loginError.textContent = ""; loginError.classList.remove("visible"); }
function showModalError(el, msg) {
    if (!msg) { el.textContent = ""; el.classList.remove("visible"); return; }
    el.textContent = msg; el.classList.add("visible");
}
function hideAllSections() {
    [loginSection, adminSection, designerSection, developerSection].forEach((s) => { if (s) s.classList.remove("active"); });
}
function showSection(s) { if (!s) return; hideAllSections(); s.classList.add("active"); }

function setLoadingStatus(msg) {
    const el = document.getElementById("loadingStatus");
    if (el) el.textContent = msg;
}

function hideLoadingScreen() {
    const o = document.getElementById("loadingOverlay");
    if (!o || o.classList.contains("hidden")) return;
    o.classList.add("fade-out");
    setTimeout(() => {
        o.classList.add("hidden");
        o.classList.remove("fade-out");
    }, 220);
}
function setDefaultBillDate() { document.getElementById("billDate").value = new Date().toISOString().split("T")[0]; }
function localId() { return "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7); }

function cleanupListeners() {
    [adminBillsUnsub, adminUsersUnsub, designerBillsUnsub, devBillsUnsub, devUsersUnsub, sessionsUnsub].forEach((u) => { if (u) u(); });
    adminBillsUnsub = adminUsersUnsub = designerBillsUnsub = devBillsUnsub = devUsersUnsub = sessionsUnsub = null;
    stopRemoteSessionWatch();
    stopPresenceUiRefresh();
    stopStorageDashboardPolling();
    stopMonitorClock();
    monitorBoardActive = false;
}

function getFriendlyError(err) {
    const c = String(err?.code || "").toLowerCase(), m = String(err?.message || err || "").toLowerCase();
    if (c === "permission-denied" || m.includes("permission")) return "Firestore Rules: allow read, write: if request.auth != null;";
    if (m.includes("timed out") || m.includes("timeout")) return "Connection slow.";
    if (m.includes("network") || m.includes("unavailable")) return "No internet. Working offline.";
    return err?.message || "Something went wrong.";
}

function isDeveloper() { return currentUser?.role === "developer"; }
function isAdmin() { return currentUser?.role === "admin"; }

function getPendingCount() {
    return getPendingBills().length + getPendingUsers().length + getPendingBillOps().length;
}

function addPendingBill(billData) {
    const pending = getPendingBills();
    pending.push(billData);
    savePendingBills(pending);

    const entry = {
        ...billData,
        id: billData.localId,
        localId: billData.localId,
        _pending: true
    };
    const cached = getCachedBills();
    if (!cached.some((b) => b.localId === billData.localId || b.id === billData.localId)) {
        cacheBills([entry, ...cached]);
    }
    updateNetworkUI();
    scheduleAutoSync(800);
}

function updatePendingBillLocal(localIdVal, data) {
    const now = new Date().toISOString();
    savePendingBills(getPendingBills().map((b) => (b.localId === localIdVal ? { ...b, ...data, updatedAt: now } : b)));
    cacheBills(getCachedBills().map((b) => {
        if (b.localId === localIdVal || b.id === localIdVal) return { ...b, ...data, _pending: true, updatedAt: now };
        return b;
    }));
    updateNetworkUI();
}

function removePendingBillLocal(localIdVal) {
    savePendingBills(getPendingBills().filter((b) => b.localId !== localIdVal));
    cacheBills(getCachedBills().filter((b) => b.localId !== localIdVal && b.id !== localIdVal));
    updateNetworkUI();
}

function markBillsSynced(localIds) {
    if (!localIds.length) return;
    const idSet = new Set(localIds);
    cacheBills(getCachedBills().map((b) => {
        if (!idSet.has(b.localId) && !idSet.has(b.id)) return b;
        const copy = { ...b };
        delete copy._pending;
        return copy;
    }));
}

function scheduleAutoSync(delay = 500) {
    if (!currentUser || !serverConnected || getPendingCount() === 0 || isSyncing) return;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(async () => {
        autoSyncTimer = null;
        if (!serverConnected || isSyncing || getPendingCount() === 0) return;
        if (!firebaseReady) await verifyFirebaseConnection();
        if (firebaseReady) await syncAll(false);
    }, delay);
}

function getPendingDeletes() {
    const ids = new Set(getDeletedBillIds());
    getPendingBillOps().forEach((op) => { if (op.type === "delete") ids.add(op.billId); });
    return ids;
}

function getPendingUpdatesMap() {
    const map = new Map();
    getPendingBillOps().forEach((op) => { if (op.type === "update") map.set(op.billId, op.data); });
    return map;
}

/** Apply server snapshot without wiping offline edits/deletes */
function applyServerBillsToCache(serverBills) {
    const deleted = getPendingDeletes();
    const updates = getPendingUpdatesMap();
    const merged = serverBills
        .filter((b) => !deleted.has(b.id))
        .map((b) => (updates.has(b.id) ? { ...b, ...updates.get(b.id) } : b));
    cacheBills(merged);
    return merged;
}

function getNetworkState() {
    if (!serverConnected) return "offline";
    if (isSyncing) return "syncing";
    if (getPendingCount() > 0) return "must-sync";
    if (!firebaseReady) return "offline-mode";
    return "online";
}

function setLoginConnectionState(state) {
    if (loginConnectionState === state) return;
    loginConnectionState = state;
    updateLoginConnectionUI();
}

function applyNetworkStatus(status) {
    const newOs = !!status?.osOnline;
    const newNet = !!status?.internetReachable;
    const newConnected = newOs && newNet;
    const prevConnected = serverConnected;
    const unchanged = newOs === osOnline && newNet === internetReachable;

    osOnline = newOs;
    internetReachable = newNet;
    serverConnected = newConnected;
    isOnline = serverConnected;
    if (status?.pingMs != null) lastPingMs = status.pingMs;

    if (!serverConnected) {
        firebaseReady = false;
        firestoreFromCache = true;
        if (networkMonitorUnsub) {
            networkMonitorUnsub();
            networkMonitorUnsub = null;
        }
        if (loginSection?.classList.contains("active") || !currentUser) {
            setLoginConnectionState("disconnected");
        }
        if (!unchanged) {
            updateNetworkUI();
            if (prevConnected && networkInitDone) {
                logMonitorEvent("network", "Connection lost — working offline", true);
            }
            refreshMonitorBoardIfActive();
        }
        if (prevConnected && networkInitDone) showToast("Not connected", true);
        return;
    }

    if (loginSection?.classList.contains("active") || !currentUser) {
        setLoginConnectionState("connected");
    }
    if (!unchanged) {
        updateNetworkUI();
        if (prevConnected === false && networkInitDone) {
            logMonitorEvent("network", "Connection restored");
        }
        refreshMonitorBoardIfActive();
    }

    if (!prevConnected && networkInitDone) {
        showToast("Back online — uploading pending data...");
        verifyFirebaseConnection().then(async () => {
            if (currentUser) {
                if (currentUser.role === "admin") {
                    subscribeAdminBills();
                    subscribeAdminUsers();
                } else if (currentUser.role === "designer") {
                    subscribeDesignerBills();
                } else if (currentUser.role === "developer") {
                    subscribeDevBills();
                    subscribeDevUsers();
                }
            }
            scheduleAutoSync(300);
        });
    } else if (serverConnected && !firebaseReady && !firebaseVerifyInFlight) {
        verifyFirebaseConnection().then(() => scheduleAutoSync(300));
    } else if (serverConnected && firebaseReady && getPendingCount() > 0) {
        scheduleAutoSync(600);
    }
}

let firebaseVerifyInFlight = false;

async function verifyFirebaseConnection() {
    if (!serverConnected || firebaseVerifyInFlight) return firebaseReady;
    firebaseVerifyInFlight = true;
    try {
        await ensureFirebaseAuth();
        const snap = await withTimeout(
            db.collection("users").doc("admin").get({ source: "server" }),
            3000,
            "timeout"
        );
        if (snap.metadata.fromCache) {
            firebaseReady = false;
            firestoreFromCache = true;
            logMonitorEvent("firebase", "Firestore serving from cache", true);
        } else {
            firebaseReady = true;
            firestoreFromCache = false;
            if (!networkMonitorUnsub) startNetworkMonitor();
            logMonitorEvent("firebase", "Firestore live — server connected");
        }
    } catch (err) {
        firebaseReady = false;
        firestoreFromCache = true;
        logMonitorEvent("firebase", getFriendlyError(err), true);
    } finally {
        firebaseVerifyInFlight = false;
        updateNetworkUI();
        if (firebaseReady && getPendingCount() > 0) scheduleAutoSync(400);
        if (currentUser) {
            registerActiveSession();
            startRemoteSessionWatch();
        }
        refreshMonitorBoardIfActive();
    }
    return firebaseReady;
}

async function initNetworkMonitoring() {
    if (window.rioNet) {
        const status = await window.rioNet.getStatus();
        applyNetworkStatus(status);
        window.rioNet.onStatusChange(applyNetworkStatus);
        networkInitDone = true;
        return;
    }

    networkInitDone = true;
    applyNetworkStatus({
        osOnline: navigator.onLine,
        internetReachable: navigator.onLine,
        connected: navigator.onLine
    });
    window.addEventListener("online", () => {
        applyNetworkStatus({ osOnline: true, internetReachable: true, connected: true });
    });
    window.addEventListener("offline", () => {
        applyNetworkStatus({ osOnline: false, internetReachable: false, connected: false });
    });
}

async function refreshConnectionStatus() {
    if (window.rioNet) {
        const status = await window.rioNet.getStatus();
        applyNetworkStatus(status);
        if (serverConnected) await verifyFirebaseConnection();
        return serverConnected;
    }
    applyNetworkStatus({
        osOnline: navigator.onLine,
        internetReachable: navigator.onLine,
        connected: navigator.onLine
    });
    if (serverConnected) await verifyFirebaseConnection();
    return serverConnected;
}

function updateLoginConnectionUI() {
    if (!connectionStatus) return;
    const map = {
        checking: { text: "Connecting…", cls: "checking" },
        connected: { text: "Connected", cls: "connected" },
        disconnected: { text: "Not connected", cls: "disconnected" }
    };
    const info = map[loginConnectionState] || map.disconnected;
    connectionStatus.textContent = info.text;
    connectionStatus.className = "login-connection " + info.cls;
}

const SIGNAL_LEVELS = { offline: 0, "offline-mode": 1, "must-sync": 2, syncing: 3, online: 4 };
const SIGNAL_LABELS = {
    offline: "Offline",
    "offline-mode": "Offline — Cached",
    "must-sync": "Pending sync",
    syncing: "Syncing…",
    online: "Online — Live"
};
const SIGNAL_CLS = {
    offline: "offline",
    "offline-mode": "offline",
    syncing: "syncing",
    "must-sync": "must-sync",
    online: "online"
};

function applySignalIndicator(el, state) {
    if (!el) return;
    const cls = SIGNAL_CLS[state] || "offline";
    const label = SIGNAL_LABELS[state] || "Offline";
    const level = SIGNAL_LEVELS[state] ?? 0;
    el.className = "network-badge " + cls;
    el.title = label;
    el.setAttribute("aria-label", label);
    const bars = el.querySelector(".signal-bars");
    if (bars) bars.setAttribute("data-level", String(level));
}

function updateNetworkUI() {
    if (networkUiFrame) return;
    networkUiFrame = requestAnimationFrame(() => {
        networkUiFrame = null;
        updateNetworkUIImmediate();
    });
}

function updateNetworkUIImmediate() {
    const onLogin = loginSection?.classList.contains("active") || !currentUser;
    if (onLogin) updateLoginConnectionUI();

    const state = getNetworkState();
    const pending = getPendingCount();

    ["admin", "designer", "dev"].forEach((role) => {
        const badge = document.getElementById(role + "NetworkBadge");
        const syncLabel = document.getElementById(role + "SyncLabel");
        const pendingEl = document.getElementById(role + "PendingCount");
        applySignalIndicator(badge, state);
        if (syncLabel) {
            if (state === "syncing") syncLabel.textContent = "Uploading...";
            else if (state === "must-sync") syncLabel.textContent = `${pending} Pending`;
            else if (state === "online") syncLabel.textContent = role === "dev" ? "Developer Live" : "Live";
            else if (state === "offline-mode") syncLabel.textContent = "Connected";
            else syncLabel.textContent = "Offline Mode";
            syncLabel.className = "live-dot" + (state === "online" ? "" : " offline-mode");
        }
        if (pendingEl) {
            pendingEl.textContent = pending;
            pendingEl.classList.toggle("hidden", pending === 0);
            pendingEl.title = pending > 0 ? `${pending} item(s) waiting to upload` : "";
        }
    });
    refreshMonitorBoardIfActive();
}

function startNetworkMonitor() {
    if (networkMonitorUnsub) networkMonitorUnsub();
    networkMonitorUnsub = db.collection("users").doc("admin").onSnapshot(
        { includeMetadataChanges: true },
        (snap) => {
            firestoreFromCache = snap.metadata.fromCache;
            if (snap.metadata.fromCache || !serverConnected) {
                firebaseReady = false;
            } else {
                firebaseReady = true;
                firestoreFromCache = false;
            }
            updateNetworkUI();
        },
        () => {
            firestoreFromCache = true;
            firebaseReady = false;
            logMonitorEvent("firebase", "Firestore listener error", true);
            updateNetworkUI();
            refreshMonitorBoardIfActive();
        }
    );
}

async function refreshBillsCacheFromServer() {
    if (!serverConnected) return;
    try {
        await ensureFirebaseAuth();
        const snap = await db.collection("bills").get({ source: "server" });
        const bills = []; snap.forEach((d) => bills.push({ id: d.id, ...d.data() }));
        applyServerBillsToCache(bills);
    } catch (e) { console.warn("Server bills refresh failed", e); }
}

async function refreshUsersCacheFromServer() {
    if (!serverConnected) return;
    try {
        await ensureFirebaseAuth();
        const snap = await db.collection("users").get({ source: "server" });
        const users = []; snap.forEach((d) => users.push({ id: d.id, ...d.data() }));
        cacheUsers(users);
    } catch (e) { console.warn("Server users refresh failed", e); }
}

async function deleteBillFromFirebase(billId) {
    await db.collection("bills").doc(billId).delete();
    cacheBills(getCachedBills().filter((b) => b.id !== billId));
    saveDeletedBillIds(getDeletedBillIds().filter((id) => id !== billId));
    savePendingBillOps(getPendingBillOps().filter((op) => !(op.type === "delete" && op.billId === billId)));
    await refreshBillsCacheFromServer();
}

async function deleteAllBillsForUser(username) {
    if (!username) return 0;
    purgeUserBillsLocally(username);
    if (!firebaseReady || !serverConnected) return 0;

    const snap = await db.collection("bills").where("username", "==", username).get({ source: "server" });
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
        const batch = db.batch();
        docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
    cacheBills(getCachedBills().filter((b) => b.username !== username));
    await refreshBillsCacheFromServer().catch(() => {});
    return docs.length;
}

function purgeUserBillsLocally(username) {
    if (!username) return;
    const userBillIds = new Set(
        getCachedBills()
            .filter((b) => b.username === username)
            .flatMap((b) => [b.id, b.localId].filter(Boolean))
    );
    savePendingBills(getPendingBills().filter((b) => b.username !== username));
    savePendingBillOps(getPendingBillOps().filter((op) => !userBillIds.has(op.billId)));
    saveDeletedBillIds(getDeletedBillIds().filter((id) => !userBillIds.has(id)));
    cacheBills(getCachedBills().filter((b) => b.username !== username));
}

async function removeUserCompletely(userId, username) {
    if (!userId || !username) return false;
    if (userId === DEV_USER || username === DEV_USER) {
        showToast("Cannot delete developer account", true);
        return false;
    }

    await deleteAllBillsForUser(username);

    if (firebaseReady && serverConnected) {
        await db.collection("users").doc(userId).delete();
        await refreshUsersCacheFromServer();
    } else {
        getPendingUsers().push({ type: "delete", userId, username, purgeBills: true });
        savePendingUsers(getPendingUsers());
        cacheUsers(getCachedUsers().filter((u) => u.id !== userId));
    }

    refreshCurrentViews();
    updateNetworkUI();
    return true;
}

function loginAsUser(user) {
    if (!user?.username || user.role === "developer") return;
    cleanupListeners();
    currentUser = { id: user.id, username: user.username, role: user.role };
    saveSession();
    routeUser();
    showToast(`Logged in as ${user.username} (${user.role})`);
}

function billSelectKey(b) {
    return `${b._pending ? "p" : "s"}:${b.localId || b.id || billFingerprint(b)}`;
}

function timestampToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatSessionTime(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-LK", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
}

function formatRelativeTime(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return formatSessionTime(ms);
}

function getUserPresenceInfo(user) {
    const session = activeSessionsMap[user.id];
    const lastSeenRaw = session?.lastActive || session?.loginTime || user.lastSeen;
    const lastMs = timestampToMs(lastSeenRaw);
    const ago = lastMs ? Date.now() - lastMs : Infinity;
    const lastSeen = lastMs ? formatRelativeTime(lastMs) : "—";

    if (session) {
        if (ago <= SESSION_ONLINE_MS) return { status: "online", label: "Online", lastSeen, lastMs };
        if (ago <= SESSION_IDLE_MS) return { status: "idle", label: "Idle", lastSeen, lastMs };
        return { status: "idle", label: "Logged In", lastSeen, lastMs };
    }
    return { status: "offline", label: "Offline", lastSeen, lastMs };
}

function sessionStatusCell(info) {
    return `<span class="session-badge ${info.status}">${info.label}</span>`;
}

function billUpdatedLabel(b) {
    const ms = timestampToMs(b.updatedAt || b.createdAt);
    if (ms) return formatRelativeTime(ms);
    return b.date || "—";
}

function subscribeActiveSessions() {
    if (sessionsUnsub) sessionsUnsub();
    if (!firebaseReady) return;
    sessionsUnsub = db.collection("active_sessions").onSnapshot((snap) => {
        activeSessionsMap = {};
        snap.forEach((d) => { activeSessionsMap[d.id] = { id: d.id, ...d.data() }; });
        refreshPresenceViews();
    }, () => {});
}

function refreshPresenceViews() {
    if (currentUser?.role === "admin") renderAdminUsers(getCachedUsers());
    if (currentUser?.role === "developer") renderDevUsers(getCachedUsers());
    refreshMonitorBoardIfActive();
}

function startPresenceUiRefresh() {
    stopPresenceUiRefresh();
    presenceUiInterval = setInterval(refreshPresenceViews, PRESENCE_UI_MS);
}

function stopPresenceUiRefresh() {
    if (presenceUiInterval) { clearInterval(presenceUiInterval); presenceUiInterval = null; }
}

async function touchUserLastSeen(userId) {
    if (!userId || !firebaseReady || !serverConnected) return;
    try {
        await db.collection("users").doc(userId).update({
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { /* ignore */ }
}

async function registerActiveSession() {
    if (!currentUser || !firebaseReady || !serverConnected) return;
    try {
        const ts = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection("active_sessions").doc(currentUser.id).set({
            username: currentUser.username,
            role: currentUser.role,
            loginTime: ts,
            lastActive: ts
        });
        await db.collection("users").doc(currentUser.id).update({ lastSeen: ts }).catch(() => {});
    } catch (e) { console.warn("Session register failed", e); }
}

async function clearActiveSession(userId) {
    const id = userId || currentUser?.id;
    if (!id || !firebaseReady) return;
    try {
        await touchUserLastSeen(id);
        await db.collection("active_sessions").doc(id).delete();
    } catch (e) { /* ignore */ }
}

async function touchActiveSession() {
    if (!currentUser || !firebaseReady || !serverConnected) return;
    try {
        const ts = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection("active_sessions").doc(currentUser.id).update({ lastActive: ts });
        await db.collection("users").doc(currentUser.id).update({ lastSeen: ts }).catch(() => {});
    } catch (e) { /* ignore */ }
}

function stopRemoteSessionWatch() {
    if (remoteSessionUnsub) { remoteSessionUnsub(); remoteSessionUnsub = null; }
    if (globalLogoutUnsub) { globalLogoutUnsub(); globalLogoutUnsub = null; }
}

function startRemoteSessionWatch() {
    stopRemoteSessionWatch();
    if (!currentUser || !firebaseReady || currentUser.role === "developer") return;

    const session = loadLS(LS.SESSION, null);
    const loginTime = session?.loginTime || 0;

    remoteSessionUnsub = db.collection("users").doc(currentUser.id).onSnapshot((snap) => {
        const forceAt = snap.data()?.forceLogoutAt;
        const forceMs = forceAt?.toMillis ? forceAt.toMillis() : (forceAt || 0);
        if (forceMs && loginTime && forceMs >= loginTime) {
            logout(true, true);
        }
    });

    globalLogoutUnsub = db.collection("system").doc("sessions").onSnapshot((snap) => {
        const forceAt = snap.data()?.forceLogoutAllAt;
        const forceMs = forceAt?.toMillis ? forceAt.toMillis() : (forceAt || 0);
        if (forceMs && loginTime && forceMs >= loginTime) {
            logout(true, true);
        }
    });
}

async function forceLogoutUser(userId, username) {
    if (!userId || userId === DEV_USER) return;
    try {
        if (firebaseReady && serverConnected) {
            await db.collection("active_sessions").doc(userId).delete().catch(() => {});
            await db.collection("users").doc(userId).update({
                forceLogoutAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        showToast(`${username} logged out remotely`);
    } catch (e) { showToast(getFriendlyError(e), true); }
}

async function forceLogoutAllUsers() {
    if (!confirm("Force logout ALL users on every device? You will stay logged in as developer.")) return;
    try {
        if (firebaseReady && serverConnected) {
            const snap = await db.collection("active_sessions").get();
            if (!snap.empty) {
                for (let i = 0; i < snap.docs.length; i += 450) {
                    const batch = db.batch();
                    snap.docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
                    await batch.commit();
                }
            }
            await db.collection("system").doc("sessions").set({
                forceLogoutAllAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        showToast("All users logged out on all devices");
        logMonitorEvent("action", "All users force-logged out");
        refreshMonitorBoardIfActive();
    } catch (e) {
        logMonitorEvent("action", getFriendlyError(e), true);
        showToast(getFriendlyError(e), true);
    }
}

async function deleteBillRecord(b) {
    if (b._pending) {
        removePendingBillLocal(b.localId);
        return;
    }
    const billId = b.id;
    if (!billId) return;
    if (firebaseReady && serverConnected) {
        await deleteBillFromFirebase(billId);
    } else {
        const ops = getPendingBillOps().filter((op) => !(op.type === "delete" && op.billId === billId));
        ops.push({ type: "delete", billId });
        savePendingBillOps(ops);
        const deleted = getDeletedBillIds();
        if (!deleted.includes(billId)) { deleted.push(billId); saveDeletedBillIds(deleted); }
        cacheBills(getCachedBills().filter((x) => x.id !== billId));
    }
}

async function deleteSelectedDevBills() {
    const toDelete = devDisplayedBills.filter((b) => devSelectedBills.has(billSelectKey(b)));
    if (!toDelete.length) { showToast("No bills selected", true); return; }
    if (!confirm(`Delete ${toDelete.length} selected bill(s) permanently?`)) return;
    for (const b of toDelete) {
        try { await deleteBillRecord(b); } catch (e) { console.warn("Bulk delete item failed", e); }
    }
    devSelectedBills.clear();
    updateDevBulkBar();
    refreshCurrentViews();
    showToast(`Deleted ${toDelete.length} bill(s)`);
}

function updateDevBulkBar() {
    const countEl = document.getElementById("devSelectedCount");
    const delBtn = document.getElementById("devDeleteSelectedBtn");
    const n = devSelectedBills.size;
    if (countEl) countEl.textContent = `${n} selected`;
    if (delBtn) delBtn.disabled = n === 0;
    const selectAll = document.getElementById("devSelectAllBills");
    const headerAll = document.getElementById("devSelectAllHeader");
    const allSelected = devDisplayedBills.length > 0 && devDisplayedBills.every((b) => devSelectedBills.has(billSelectKey(b)));
    if (selectAll) selectAll.checked = allSelected;
    if (headerAll) headerAll.checked = allSelected;
}

function renderDevBillsTable(bills) {
    devDisplayedBills = bills;
    const tbody = document.getElementById("devBillsBody");
    if (!tbody) return 0;

    let grandTotal = 0;
    if (!bills.length) {
        tbody.innerHTML = `<tr><td colspan="11" class="empty-state">No bills for this filter.</td></tr>`;
        document.getElementById("devTableTotal").textContent = "Rs. 0.00";
        updateDevBulkBar();
        return 0;
    }

    tbody.innerHTML = bills.map((b) => {
        const key = billSelectKey(b);
        const checked = devSelectedBills.has(key) ? " checked" : "";
        grandTotal += billLineTotal(b);
        return `<tr class="dev-bill-row${checked ? " selected" : ""}" data-key="${escAttr(key)}" title="Double-click to edit">
            <td class="col-check"><input type="checkbox" class="dev-bill-check" data-key="${escAttr(key)}"${checked}></td>
            ${billRowCells(b, { showDesigner: true, showActions: true, showUpdated: true, actionsUseKey: true })}
        </tr>`;
    }).join("");

    document.getElementById("devTableTotal").textContent = "Rs. " + formatMoney(grandTotal);
    bindDevBillActions(tbody);

    tbody.querySelectorAll(".dev-bill-check").forEach((cb) => {
        cb.addEventListener("change", () => {
            const key = cb.dataset.key;
            if (cb.checked) devSelectedBills.add(key);
            else devSelectedBills.delete(key);
            cb.closest("tr")?.classList.toggle("selected", cb.checked);
            updateDevBulkBar();
        });
    });

    tbody.querySelectorAll(".dev-bill-row").forEach((row) => {
        row.addEventListener("dblclick", (e) => {
            if (e.target.closest("button, input, .btn-action")) return;
            row.querySelector(".bill-edit-btn")?.click();
        });
    });

    updateDevBulkBar();
    updateNetworkUI();
    return grandTotal;
}

// ─── Session (24h auto logout) ───
function saveSession() {
    if (!currentUser) return;
    saveLS(LS.SESSION, { loginTime: Date.now(), user: currentUser });
}

function clearSession() { localStorage.removeItem(LS.SESSION); }

function checkSessionExpiry() {
    const session = loadLS(LS.SESSION, null);
    if (!session || !currentUser) return;
    if (Date.now() - session.loginTime >= SESSION_MS) {
        showToast("Session expired — auto logout after 24 hours");
        logout(true);
    }
}

function tryRestoreSession() {
    const session = loadLS(LS.SESSION, null);
    if (!session || !session.user) return false;
    if (Date.now() - session.loginTime >= SESSION_MS) { clearSession(); return false; }
    currentUser = session.user;
    routeUser(true);
    return true;
}

let sessionVisibilityBound = false;

function startSessionMonitor() {
    if (sessionCheckInterval) clearInterval(sessionCheckInterval);
    sessionCheckInterval = setInterval(() => {
        checkSessionExpiry();
        touchActiveSession();
    }, SESSION_HEARTBEAT_MS);
    registerActiveSession();
    startRemoteSessionWatch();
    subscribeActiveSessions();
    startPresenceUiRefresh();
    if (!sessionVisibilityBound) {
        sessionVisibilityBound = true;
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                checkSessionExpiry();
                touchActiveSession();
            }
        });
    }
}

async function ensureFirebaseAuth() {
    if (!serverConnected) throw new Error("offline");
    if (firebaseReady && auth.currentUser) return;
    await retryOperation(async () => { if (!auth.currentUser) await auth.signInAnonymously(); }, 2, 800, 15000);
    firebaseReady = true;
}

async function checkFirebaseOnline() {
    return refreshConnectionStatus();
}

function tryOfflineLogin(username, password) {
    const user = getCachedUsers().find((u) => u.username === username);
    if (!user || user.password !== password) return null;
    return { id: user.id, username: user.username, role: user.role };
}

async function verifyAdminPasswordOnline(password) {
    if (!currentUser || currentUser.role !== "admin") return false;
    const c = getCachedUsers().find((u) => u.id === currentUser.id);
    if (c && c.password === password) return true;
    if (!firebaseReady) return false;
    try {
        const snap = await db.collection("users").doc(currentUser.id).get();
        return snap.exists && snap.data().password === password;
    } catch { return false; }
}

// ─── Sync ───
async function syncPendingBills() {
    const pending = getPendingBills(), remaining = [];
    const syncedIds = [];
    let synced = 0;
    for (const bill of pending) {
        try {
            const ref = db.collection("bills").doc(bill.localId);
            const existing = await ref.get();
            if (!existing.exists) {
                await ref.set({
                    date: bill.date, billNo: bill.billNo, price: bill.price,
                    description: bill.description || "", designCharge: billDesignCharge(bill),
                    username: bill.username,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
            syncedIds.push(bill.localId);
            synced++;
        } catch { remaining.push(bill); }
    }
    savePendingBills(remaining);
    markBillsSynced(syncedIds);
    return synced;
}

async function syncPendingBillOps() {
    const ops = getPendingBillOps(), remaining = [];
    let synced = 0;
    const deletedIds = getDeletedBillIds();
    for (const op of ops) {
        try {
            if (op.type === "delete") {
                await db.collection("bills").doc(op.billId).delete();
            } else if (op.type === "update") {
                await db.collection("bills").doc(op.billId).update(op.data);
            }
            synced++;
        } catch { remaining.push(op); }
    }
    savePendingBillOps(remaining);
    for (const id of deletedIds) {
        if (remaining.some((op) => op.type === "delete" && op.billId === id)) continue;
        try { await db.collection("bills").doc(id).delete(); } catch { continue; }
    }
    saveDeletedBillIds([]);
    return synced;
}

async function syncPendingUsers() {
    const pending = getPendingUsers(), remaining = [];
    let synced = 0;
    for (const op of pending) {
        try {
            if (op.type === "add") {
                await db.collection("users").doc(op.username).set({ username: op.username, password: op.password, role: op.role || "designer" });
            } else if (op.type === "update") {
                await db.collection("users").doc(op.userId).update({ password: op.password });
            } else if (op.type === "delete") {
                if (op.username && op.purgeBills) await deleteAllBillsForUser(op.username);
                else if (op.username) purgeUserBillsLocally(op.username);
                await db.collection("users").doc(op.userId).delete();
            }
            synced++;
        } catch { remaining.push(op); }
    }
    savePendingUsers(remaining);
    return synced;
}

async function refreshUsersCache() {
    if (!firebaseReady) return;
    await refreshUsersCacheFromServer();
}

async function refreshBillsCache() {
    if (!firebaseReady) return;
    await refreshBillsCacheFromServer();
}

async function syncAll(manual = false) {
    if (isSyncing) return;
    if (!serverConnected) { if (manual) showToast("Offline Mode — connect to update", true); updateNetworkUI(); return; }
    isSyncing = true;
    updateNetworkUI();
    ["adminSyncBtn", "designerSyncBtn", "devSyncBtn"].forEach((id) => document.getElementById(id)?.classList.add("syncing"));
    try {
        await ensureFirebaseAuth();
        const opsSynced = await syncPendingBillOps();
        const billsSynced = await syncPendingBills();
        const usersSynced = await syncPendingUsers();
        const t = opsSynced + billsSynced + usersSynced;
        await refreshUsersCacheFromServer();
        await refreshBillsCacheFromServer();
        firestoreFromCache = false;
        lastSyncTime = Date.now();
        logMonitorEvent("sync", t > 0 ? `Synced ${t} pending change${t !== 1 ? "s" : ""}` : "All data up to date");
        refreshCurrentViews();
        updateNetworkUI();
        refreshMonitorBoardIfActive();
        if (manual) {
            showToast(t > 0 ? `All data updated (${t} change${t !== 1 ? "s" : ""})` : "All data updated");
        } else if (billsSynced > 0) {
            showToast(`${billsSynced} bill${billsSynced !== 1 ? "s" : ""} uploaded automatically`);
        } else if (t > 0) {
            showToast(`${t} pending change${t !== 1 ? "s" : ""} synced`);
        }
    } catch (err) {
        logMonitorEvent("sync", getFriendlyError(err), true);
        if (manual) showToast(getFriendlyError(err), true);
    }
    finally {
        isSyncing = false;
        ["adminSyncBtn", "designerSyncBtn", "devSyncBtn"].forEach((id) => document.getElementById(id)?.classList.remove("syncing"));
        updateNetworkUI();
        if (getPendingCount() > 0 && serverConnected) scheduleAutoSync(2000);
    }
}

function refreshCurrentViews() {
    if (!currentUser) return;
    if (currentUser.role === "admin") { refreshAdminBillsView(); renderAdminUsers(getCachedUsers()); applyAdminReportFilter(); }
    if (currentUser.role === "designer") refreshDesignerViews();
    if (currentUser.role === "developer") { refreshDevBillsView(); renderDevUsers(getCachedUsers()); }
}

// ─── Bills merge & render helpers ───
function resolveBillSource(cloudBills, usernameFilter) {
    if (cloudBills !== undefined && cloudBills !== null) {
        return usernameFilter ? cloudBills.filter((b) => b.username === usernameFilter) : cloudBills;
    }
    const cached = getCachedBills();
    return usernameFilter ? cached.filter((b) => b.username === usernameFilter) : cached;
}

function mergeBills(cloudBills, usernameFilter) {
    const deleted = getPendingDeletes();
    const updates = getPendingUpdatesMap();
    let bills = resolveBillSource(cloudBills, usernameFilter)
        .filter((b) => !deleted.has(b.id))
        .map((b) => (updates.has(b.id) ? { ...b, ...updates.get(b.id), _pending: true } : b));

    const pendingKeys = new Set(bills.map((b) => billFingerprint(b)));
    getPendingBills().forEach((b) => {
        if (usernameFilter && b.username !== usernameFilter) return;
        const key = billFingerprint(b);
        if (pendingKeys.has(key)) return;
        bills.push({ ...b, id: b.localId, localId: b.localId, _pending: true });
        pendingKeys.add(key);
    });

    bills.sort((a, b) => {
        const ta = a.createdAt?.seconds || new Date(a.createdAt || a.date).getTime() / 1000 || 0;
        const tb = b.createdAt?.seconds || new Date(b.createdAt || b.date).getTime() / 1000 || 0;
        return tb - ta;
    });
    return bills;
}

function statusCell(pending) {
    return pending
        ? `<span class="status-badge pending" title="Saved locally — uploads when online">Pending</span>`
        : `<span class="status-badge synced">Synced</span>`;
}

function billActions(b, opts = {}) {
    if (opts.useKey) {
        const key = escAttr(billSelectKey(b));
        return `<div class="btn-action-group">
            <button type="button" class="btn-action edit bill-edit-btn" data-key="${key}">Edit</button>
            <button type="button" class="btn-action delete bill-delete-btn" data-key="${key}">Delete</button>
        </div>`;
    }
    return `<div class="btn-action-group">
        <button type="button" class="btn-action edit bill-edit-btn"
            data-id="${b.id || ""}" data-pending="${b._pending ? "1" : "0"}"
            data-local="${b.localId || ""}" data-date="${b.date || ""}"
            data-billno="${escAttr(b.billNo)}" data-price="${b.price || 0}"
            data-description="${escAttr(b.description)}" data-designcharge="${billDesignCharge(b)}">Edit</button>
        <button type="button" class="btn-action delete bill-delete-btn"
            data-id="${b.id || ""}" data-pending="${b._pending ? "1" : "0"}"
            data-local="${b.localId || ""}" data-billno="${escAttr(b.billNo)}">Delete</button>
    </div>`;
}

function billRowCells(b, opts) {
    const { showDesigner = false, showActions = false, showUpdated = false, actionsUseKey = false } = opts;
    const price = parseFloat(b.price || 0);
    const design = billDesignCharge(b);
    const total = billLineTotal(b);
    const desc = b.description ? `<span class="desc-col" title="${escAttr(b.description)}">${b.description}</span>` : `<span class="money-sub">—</span>`;
    const billIdAttr = b.id ? `data-bill-id="${b.id}"` : (b.localId ? `data-bill-id="${b.localId}"` : '');
    return `<tr ${billIdAttr}>${showDesigner || showActions || showUpdated ? '' : ''}
        <td>${b.date || "—"}</td>
        <td><strong>${b.billNo || "—"}</strong></td>
        ${showDesigner ? `<td><span class="role-badge designer">${b.username || "?"}</span></td>` : ""}
        <td>${desc}</td>
        <td class="money-col">${formatMoney(price)}</td>
        <td class="money-sub">${design > 0 ? formatMoney(design) : "—"}</td>
        <td class="money-col total-col">${formatMoney(total)}</td>
        ${showUpdated ? `<td class="session-time col-updated" title="${escAttr(formatSessionTime(b.updatedAt || b.createdAt))}">${billUpdatedLabel(b)}</td>` : ""}
        <td>${statusCell(b._pending)}</td>
        ${showActions ? `<td class="col-actions">${billActions(b, { useKey: actionsUseKey })}</td>` : ""}`;
}

function openBillEditFromBill(b) {
    if (!b) return;
    openBillEdit({
        id: b.id || b.localId || "",
        pending: !!b._pending,
        localId: b.localId || b.id || "",
        date: b.date || "",
        billNo: b.billNo || "",
        price: b.price ?? "",
        description: b.description || "",
        designCharge: billDesignCharge(b)
    });
}

function openBillDeleteFromBill(b) {
    if (!b) return;
    openBillDelete({
        id: b.id || b.localId || "",
        pending: !!b._pending,
        localId: b.localId || b.id || "",
        billNo: b.billNo || ""
    });
}

function bindDevBillActions(container) {
    container.querySelectorAll(".bill-edit-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const bill = devDisplayedBills.find((b) => billSelectKey(b) === btn.dataset.key);
            openBillEditFromBill(bill);
        });
    });
    container.querySelectorAll(".bill-delete-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const bill = devDisplayedBills.find((b) => billSelectKey(b) === btn.dataset.key);
            openBillDeleteFromBill(bill);
        });
    });
}

function bindBillActions(container) {
    container.querySelectorAll(".bill-edit-btn").forEach((btn) => {
        btn.addEventListener("click", () => openBillEdit({
            id: btn.dataset.id, pending: btn.dataset.pending === "1",
            localId: btn.dataset.local, date: btn.dataset.date,
            billNo: btn.dataset.billno, price: btn.dataset.price,
            description: btn.dataset.description, designCharge: btn.dataset.designcharge
        }));
    });
    container.querySelectorAll(".bill-delete-btn").forEach((btn) => {
        btn.addEventListener("click", () => openBillDelete({
            id: btn.dataset.id, pending: btn.dataset.pending === "1",
            localId: btn.dataset.local, billNo: btn.dataset.billno
        }));
    });
}

function renderBillsTable(tbodyId, bills, opts = {}) {
    const { showDesigner = false, showActions = false, showUpdated = false, totalIds = {}, designTotalId = null } = opts;
    let grandTotal = 0, designTotal = 0;
    const emptyCols = (showDesigner ? 8 : 7) + (showUpdated ? 1 : 0) + (showActions ? 1 : 0);
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return 0;
    tbody.innerHTML = bills.length === 0
        ? `<tr><td colspan="${emptyCols}" class="empty-state">No bills yet.</td></tr>`
        : bills.map((b) => {
            grandTotal += billLineTotal(b);
            designTotal += billDesignCharge(b);
            return billRowCells(b, { showDesigner, showActions, showUpdated });
        }).join("");
    if (totalIds.revenue) document.getElementById(totalIds.revenue).textContent = "Rs. " + formatMoney(grandTotal);
    if (totalIds.table) document.getElementById(totalIds.table).textContent = "Rs. " + formatMoney(grandTotal);
    if (totalIds.count) document.getElementById(totalIds.count).textContent = `${bills.length} bill${bills.length !== 1 ? "s" : ""}`;
    if (designTotalId) document.getElementById(designTotalId).textContent = "Rs. " + formatMoney(designTotal);
    if (showActions) bindBillActions(tbody);
    updateNetworkUI();
    return grandTotal;
}

// ─── Bill Edit/Delete ───
function openBillEdit(b) {
    document.getElementById("editBillId").value = b.id || "";
    document.getElementById("editBillPending").value = b.pending ? "1" : "0";
    document.getElementById("editBillLocalId").value = b.localId || "";
    document.getElementById("editBillDate").value = b.date || "";
    document.getElementById("editBillNo").value = b.billNo || "";
    document.getElementById("editBillDescription").value = b.description || "";
    document.getElementById("editBillPrice").value = b.price || "";
    document.getElementById("editBillDesignCharge").value = billDesignCharge(b) || "";
    showModalError(document.getElementById("billEditError"), "");
    document.getElementById("billEditModal").classList.remove("hidden");
    updateDesignerCapsUI();
}

function openBillDelete(b) {
    document.getElementById("deleteBillId").value = b.id || "";
    document.getElementById("deleteBillPending").value = b.pending ? "1" : "0";
    document.getElementById("deleteBillLocalId").value = b.localId || "";
    document.getElementById("deleteBillNo").textContent = b.billNo || "—";
    showModalError(document.getElementById("billDeleteError"), "");
    document.getElementById("billDeleteModal").classList.remove("hidden");
}

function closeBillModals() {
    document.getElementById("billEditModal").classList.add("hidden");
    document.getElementById("billDeleteModal").classList.add("hidden");
}

["billEditClose", "billEditCancel", "billDeleteClose", "billDeleteCancel"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", closeBillModals);
});

document.getElementById("billEditSave").addEventListener("click", async () => {
    const errEl = document.getElementById("billEditError");
    const billId = document.getElementById("editBillId").value || localIdVal;
    const isPending = document.getElementById("editBillPending").value === "1";
    const localIdVal = document.getElementById("editBillLocalId").value;
    const date = document.getElementById("editBillDate").value;
    const billNo = applyDesignerCapsText(document.getElementById("editBillNo").value.trim());
    const description = applyDesignerCapsText(document.getElementById("editBillDescription").value.trim());
    const price = parseFloat(document.getElementById("editBillPrice").value);
    const designChargeRaw = document.getElementById("editBillDesignCharge").value;
    if (!date || !billNo || !description || isNaN(price) || price < 0) { showModalError(errEl, "Fill all required fields correctly."); return; }
    const { designCharge } = normalizeBillInput(description, designChargeRaw);
    const data = { date, billNo, description, price, designCharge };

    if (isPending) {
        updatePendingBillLocal(localIdVal, data);
        showToast("Bill updated locally");
        closeBillModals(); refreshCurrentViews(); return;
    }

    if (firebaseReady && serverConnected) {
        try {
            await db.collection("bills").doc(billId).update({
                ...data,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            savePendingBillOps(getPendingBillOps().filter((op) => !(op.type === "update" && op.billId === billId)));
            await refreshBillsCacheFromServer();
            showToast("Bill updated");
            closeBillModals(); refreshCurrentViews();
        } catch (e) { showModalError(errEl, getFriendlyError(e)); }
    } else {
        const ops = getPendingBillOps().filter((op) => !(op.type === "update" && op.billId === billId));
        ops.push({ type: "update", billId, data });
        savePendingBillOps(ops);
        const bills = getCachedBills().map((b) => b.id === billId ? { ...b, ...data } : b);
        cacheBills(bills);
        showToast("Bill updated (offline)");
        closeBillModals(); refreshCurrentViews(); updateNetworkUI();
    }
});

document.getElementById("billDeleteConfirm").addEventListener("click", async () => {
    const errEl = document.getElementById("billDeleteError");
    const billId = document.getElementById("deleteBillId").value;
    const isPending = document.getElementById("deleteBillPending").value === "1";
    const localIdVal = document.getElementById("deleteBillLocalId").value;

    if (isPending) {
        removePendingBillLocal(localIdVal);
        showToast("Pending bill removed");
        closeBillModals(); refreshCurrentViews(); return;
    }

    try {
        await deleteBillRecord({ id: billId, _pending: false, localId: localIdVal });
        showToast("Bill deleted");
        closeBillModals(); refreshCurrentViews();
    } catch (e) { showModalError(errEl, getFriendlyError(e)); }
});

// ─── Login ───
loginForm.addEventListener("submit", async (e) => {
    e.preventDefault(); hideLoginError();
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!username || !password) { showLoginError("Enter username and password."); return; }
    loginBtn.disabled = true; loginBtn.textContent = "Signing in...";
    try {
        let loggedIn = null;
        if (serverConnected) {
            try {
                await ensureFirebaseAuth();
                let userData, userId;
                const direct = await retryOperation(() => db.collection("users").doc(username).get(), 2, 800, 10000);
                if (direct.exists) { userData = direct.data(); userId = direct.id; }
                else {
                    const q = await retryOperation(() => db.collection("users").where("username", "==", username).limit(1).get(), 2, 800, 10000);
                    if (q.empty) throw new Error("invalid");
                    userData = q.docs[0].data(); userId = q.docs[0].id;
                }
                if (userData.password !== password) throw new Error("invalid");
                loggedIn = { id: userId, username: userData.username, role: userData.role };
                await refreshUsersCache();
            } catch (err) {
                if (String(err?.message) === "invalid") { showLoginError("Invalid username or password."); return; }
            }
        }
        if (!loggedIn) {
            loggedIn = tryOfflineLogin(username, password);
            if (!loggedIn) {
                showLoginError(serverConnected ? "Invalid login or no cached account." : "Offline — login online once first.");
                return;
            }
            showToast("Logged in offline");
        }
        currentUser = loggedIn; loginForm.reset(); routeUser();
    } catch (err) { showLoginError(getFriendlyError(err)); }
    finally { loginBtn.disabled = false; loginBtn.textContent = "Sign In"; }
});

function routeUser(restored = false) {
    cleanupListeners();
    updateNetworkUI();
    if (!currentUser) { showSection(loginSection); return; }
    if (currentUser.role === "admin") { initAdminDashboard(); showSection(adminSection); }
    else if (currentUser.role === "designer") { initDesignerDashboard(); showSection(designerSection); }
    else if (currentUser.role === "developer") { initDeveloperDashboard(); showSection(developerSection); }
    else { showLoginError("Unknown role."); currentUser = null; showSection(loginSection); return; }
    if (!restored) saveSession();
    startSessionMonitor();
    if (serverConnected && getPendingCount() > 0) scheduleAutoSync(500);
    else if (serverConnected) syncAll(false);
}

function logout(isAuto = false, remote = false) {
    const userId = currentUser?.id;
    cleanupListeners();
    if (networkMonitorUnsub) { networkMonitorUnsub(); networkMonitorUnsub = null; }
    if (sessionCheckInterval) { clearInterval(sessionCheckInterval); sessionCheckInterval = null; }
    clearActiveSession(userId);
    currentUser = null;
    clearSession();
    loginForm.reset(); hideLoginError();
    setLoginConnectionState(serverConnected ? "connected" : "disconnected");
    showSection(loginSection);
    updateNetworkUI();
    if (remote) showToast("Logged out remotely by administrator", true);
    else showToast(isAuto ? "Logged out — 24 hour session ended" : "Logged out");
}

document.getElementById("adminLogoutBtn").addEventListener("click", logout);
document.getElementById("designerLogoutBtn").addEventListener("click", logout);
document.getElementById("devLogoutBtn").addEventListener("click", logout);
document.getElementById("adminSyncBtn").addEventListener("click", () => syncAll(true));
document.getElementById("designerSyncBtn").addEventListener("click", () => syncAll(true));
document.getElementById("devSyncBtn").addEventListener("click", () => syncAll(true));

document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("[data-admin-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll("#adminSection .admin-tab-panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.adminTab));
        if (btn.dataset.adminTab === "adminReportsPanel") applyAdminReportFilter();
    });
});

document.querySelectorAll("[data-dev-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("[data-dev-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll("#developerSection .admin-tab-panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.devTab));
        if (btn.dataset.devTab === "devStoragePanel") {
            monitorBoardActive = true;
            subscribeActiveSessions();
            refreshMonitorBoard();
            startStorageDashboardPolling();
            startMonitorClock();
            logMonitorEvent("system", "Monitor board opened");
        } else {
            monitorBoardActive = false;
            stopStorageDashboardPolling();
            stopMonitorClock();
        }
    });
});

function formatBytes(bytes) {
    const n = Math.max(0, bytes || 0);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(2) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function isMonitorTabActive() {
    return document.getElementById("devStoragePanel")?.classList.contains("active");
}

function refreshMonitorBoardIfActive() {
    if (monitorBoardActive || isMonitorTabActive()) refreshMonitorBoard();
}

function logMonitorEvent(type, message, isError = false) {
    monitorLog.unshift({ ts: Date.now(), type, message, isError: !!isError });
    if (monitorLog.length > MONITOR_LOG_MAX) monitorLog.length = MONITOR_LOG_MAX;
    if (monitorBoardActive) renderMonitorLog();
}

function formatMonitorTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString("en-LK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function getPendingBreakdown() {
    return {
        bills: getPendingBills().length,
        users: getPendingUsers().length,
        ops: getPendingBillOps().length
    };
}

function computeStorageStats() {
    const bills = mergeBills();
    const users = getCachedUsers();
    const pendingPayload = {
        bills: getPendingBills(),
        users: getPendingUsers(),
        ops: getPendingBillOps()
    };
    const billsBytes = new Blob([JSON.stringify(bills)]).size;
    const usersBytes = new Blob([JSON.stringify(users)]).size;
    const pendingBytes = new Blob([JSON.stringify(pendingPayload)]).size;
    let localBytes = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("rio_")) {
                localBytes += ((localStorage.getItem(key) || "").length) * 2;
            }
        }
    } catch (e) { /* ignore */ }

    const firestoreEst = billsBytes + usersBytes;
    const localTotal = pendingBytes + localBytes;
    const activeLogins = Object.keys(activeSessionsMap).length;
    const networkState = getNetworkState();
    const pendingBreakdown = getPendingBreakdown();
    const revenue = bills.reduce((sum, b) => sum + billLineTotal(b), 0);
    const errors24h = monitorLog.filter((e) => e.isError && Date.now() - e.ts < 86400000).length;

    return {
        billsBytes, usersBytes, pendingBytes, localBytes,
        firestoreEst, localTotal, billsCount: bills.length,
        usersCount: users.length, activeLogins,
        pendingCount: getPendingCount(), networkState,
        pendingBreakdown, revenue, errors24h
    };
}

function renderDevNetworkMetric(state, badgeId = "devMetricNetworkBadge", labelId = "devMetricNetworkLabel") {
    const badge = document.getElementById(badgeId);
    const label = labelId ? document.getElementById(labelId) : null;
    if (!badge) return;
    const level = SIGNAL_LEVELS[state] ?? 0;
    const text = SIGNAL_LABELS[state] || "Offline";
    badge.innerHTML = `<div class="network-badge ${SIGNAL_CLS[state] || "offline"} metric-signal-badge" title="${text}">
        <div class="signal-bars" data-level="${level}"><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>
    </div>`;
    if (label) label.textContent = text;
}

function renderDevAnalyzeChart(stats) {
    const el = document.getElementById("devAnalyzeChart");
    if (!el) return;
    const total = stats.billsBytes + stats.usersBytes + stats.pendingBytes + stats.localBytes || 1;
    const items = [
        { label: "Bills Data", bytes: stats.billsBytes, color: "#ff5252" },
        { label: "Users Data", bytes: stats.usersBytes, color: "#00e676" },
        { label: "Pending Sync", bytes: stats.pendingBytes, color: "#ffab00" },
        { label: "Local Cache", bytes: stats.localBytes, color: "#448aff" }
    ];
    el.innerHTML = items.map((i) => {
        const pct = Math.max(2, (i.bytes / total) * 100);
        return `<div class="analyze-row">
            <span class="analyze-label">${i.label}</span>
            <div class="analyze-bar-track"><div class="analyze-bar-fill" style="width:${pct.toFixed(1)}%;background:${i.color}"></div></div>
            <span class="analyze-val">${formatBytes(i.bytes)}</span>
        </div>`;
    }).join("");
}

function renderMonitorSessions() {
    const el = document.getElementById("monitorSessionsList");
    const badge = document.getElementById("monitorSessionBadge");
    if (!el) return;
    const sessions = Object.values(activeSessionsMap);
    if (badge) badge.textContent = String(sessions.length);
    if (!sessions.length) {
        el.innerHTML = `<div class="monitor-empty">No active sessions</div>`;
        return;
    }
    el.innerHTML = sessions.map((s) => {
        const lastMs = timestampToMs(s.lastActive || s.loginTime);
        const ago = lastMs ? formatRelativeTime(lastMs) : "—";
        const ageMs = lastMs ? Date.now() - lastMs : Infinity;
        const dotCls = ageMs <= SESSION_ONLINE_MS ? "online" : ageMs <= SESSION_IDLE_MS ? "idle" : "idle";
        const roleCls = s.role === "admin" ? "admin" : s.role === "developer" ? "dev" : "designer";
        return `<div class="monitor-session-row">
            <span class="monitor-session-dot ${dotCls}"></span>
            <div class="monitor-session-info">
                <strong>${escAttr(s.username || s.id)}</strong>
                <span class="monitor-session-role ${roleCls}">${s.role || "user"}</span>
            </div>
            <span class="monitor-session-time">${ago}</span>
        </div>`;
    }).join("");
}

function renderMonitorLog() {
    const el = document.getElementById("monitorLogList");
    if (!el) return;
    if (!monitorLog.length) {
        el.innerHTML = `<div class="monitor-empty">No events yet</div>`;
        return;
    }
    el.innerHTML = monitorLog.slice(0, 40).map((e) => {
        return `<div class="monitor-log-row ${e.isError ? "error" : e.type}">
            <span class="monitor-log-time">${formatMonitorTime(e.ts)}</span>
            <span class="monitor-log-type">${escAttr(e.type)}</span>
            <span class="monitor-log-msg">${escAttr(e.message)}</span>
        </div>`;
    }).join("");
}

function setMonitorTileState(tileId, state) {
    const tile = document.getElementById(tileId);
    if (!tile) return;
    tile.classList.remove("ok", "warn", "error", "syncing");
    if (state) tile.classList.add(state);
}

function refreshMonitorBoard() {
    const stats = computeStorageStats();
    const fsPct = Math.min(100, (stats.firestoreEst / FIRESTORE_STORAGE_LIMIT) * 100);
    const localPct = Math.min(100, (stats.localTotal / LOCAL_STORAGE_LIMIT) * 100);
    const netState = stats.networkState;
    const now = Date.now();

    const barFill = document.getElementById("devStorageBarFill");
    if (barFill) {
        barFill.style.width = fsPct.toFixed(1) + "%";
        barFill.classList.toggle("warn", fsPct >= STORAGE_WARN_PERCENT);
        barFill.classList.toggle("danger", fsPct >= 95);
    }
    const localBar = document.getElementById("devLocalStorageBarFill");
    if (localBar) {
        localBar.style.width = localPct.toFixed(1) + "%";
        localBar.classList.toggle("warn", localPct >= STORAGE_WARN_PERCENT);
    }

    const usedEl = document.getElementById("devStorageUsed");
    const pctEl = document.getElementById("devStoragePercent");
    const warnEl = document.getElementById("devStorageWarning");
    if (usedEl) usedEl.textContent = formatBytes(stats.firestoreEst);
    if (pctEl) pctEl.textContent = fsPct.toFixed(1) + "%";
    if (document.getElementById("devLocalStorageUsed")) {
        document.getElementById("devLocalStorageUsed").textContent = formatBytes(stats.localTotal);
    }
    if (warnEl) warnEl.classList.toggle("hidden", fsPct < STORAGE_WARN_PERCENT);

    const pb = stats.pendingBreakdown;
    const connText = SIGNAL_LABELS[netState] || "Offline";
    setText("monitorConnStatus", connText);
    setText("monitorConnSub", lastPingMs != null ? `${lastPingMs} ms ping` : (serverConnected ? "Connected" : "No internet"));
    setMonitorTileState("monitorTileConnection", netState === "online" ? "ok" : netState === "syncing" ? "syncing" : netState === "must-sync" ? "warn" : "error");

    const fbLive = firebaseReady && !firestoreFromCache;
    setText("monitorFirebaseStatus", fbLive ? "Live" : firestoreFromCache ? "Cache" : "Offline");
    setText("monitorFirebaseSub", firebaseReady ? "Server data" : "Not connected");
    setMonitorTileState("monitorTileFirebase", fbLive ? "ok" : firebaseReady ? "warn" : "error");

    setText("monitorSyncCount", String(stats.pendingCount));
    setText("monitorSyncSub", stats.pendingCount ? `${pb.bills} bills · ${pb.users} users · ${pb.ops} ops` : "all synced");
    setMonitorTileState("monitorTileSync", stats.pendingCount > 0 ? "warn" : "ok");

    setText("monitorActiveUsers", String(stats.activeLogins));
    setText("monitorActiveUsersSub", stats.activeLogins === 1 ? "user online" : "users online");
    setMonitorTileState("monitorTileUsers", stats.activeLogins > 0 ? "ok" : "");

    setText("monitorBillCount", String(stats.billsCount));
    setText("monitorRevenueSub", "Rs. " + formatMoney(stats.revenue));
    setText("monitorErrorCount", String(stats.errors24h));
    setMonitorTileState("monitorTileErrors", stats.errors24h > 0 ? "error" : "ok");

    setText("monitorOsNet", osOnline ? "Online" : "Offline");
    setText("monitorPing", lastPingMs != null ? `${lastPingMs} ms` : serverConnected ? "Measuring…" : "—");
    setText("monitorFbAuth", firebaseReady ? "Authenticated" : serverConnected ? "Pending" : "Offline");
    setText("monitorFsSource", !serverConnected ? "Offline" : firestoreFromCache ? "Local Cache" : "Live Server");
    setText("monitorAppState", isSyncing ? "Syncing…" : SIGNAL_LABELS[netState] || "Offline");
    setText("monitorLastSync", lastSyncTime ? formatRelativeTime(lastSyncTime) : "Never");

    setText("monitorUsersData", "Users: " + formatBytes(stats.usersBytes));
    setText("monitorBillsData", "Bills: " + formatBytes(stats.billsBytes));
    setText("monitorPendingData", "Pending: " + formatBytes(stats.pendingBytes));

    renderDevNetworkMetric(netState, "monitorNetworkBadge", null);
    renderDevAnalyzeChart(stats);
    renderMonitorSessions();
    renderMonitorLog();

    const refreshLbl = document.getElementById("monitorLastRefresh");
    if (refreshLbl) refreshLbl.textContent = "Updated " + formatMonitorTime(now);

    const livePill = document.getElementById("monitorLivePill");
    if (livePill) livePill.classList.toggle("paused", !monitorBoardActive);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function refreshDevStorageDashboard() {
    refreshMonitorBoard();
}

function startStorageDashboardPolling() {
    stopStorageDashboardPolling();
    storageDashboardInterval = setInterval(refreshMonitorBoard, MONITOR_POLL_MS);
}

function stopStorageDashboardPolling() {
    if (storageDashboardInterval) {
        clearInterval(storageDashboardInterval);
        storageDashboardInterval = null;
    }
}

function startMonitorClock() {
    stopMonitorClock();
    const tick = () => {
        const el = document.getElementById("monitorClock");
        if (el) el.textContent = new Date().toLocaleTimeString("en-LK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    };
    tick();
    monitorClockInterval = setInterval(tick, 1000);
}

function stopMonitorClock() {
    if (monitorClockInterval) {
        clearInterval(monitorClockInterval);
        monitorClockInterval = null;
    }
}

async function monitorFixConnection() {
    logMonitorEvent("action", "Running connection repair…");
    showToast("Repairing connection…");
    const ok = await refreshConnectionStatus();
    if (ok) await verifyFirebaseConnection();
    if (currentUser?.role === "developer") {
        subscribeDevBills();
        subscribeDevUsers();
        subscribeActiveSessions();
        if (!networkMonitorUnsub && firebaseReady) startNetworkMonitor();
    }
    if (getPendingCount() > 0 && serverConnected) await syncAll(true);
    refreshMonitorBoard();
    logMonitorEvent("action", ok && firebaseReady ? "Connection repair complete" : "Repair finished — check status", !(ok && firebaseReady));
    showToast(ok && firebaseReady ? "Connection fixed" : "Repair done — see monitor", !(ok && firebaseReady));
}

function exportMonitorDiagnostics() {
    const stats = computeStorageStats();
    const diag = {
        exportedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        uptime: formatUptime(Date.now() - appStartTime),
        connection: { osOnline, internetReachable, serverConnected, pingMs: lastPingMs, state: getNetworkState() },
        firebase: { ready: firebaseReady, fromCache: firestoreFromCache },
        storage: stats,
        pending: getPendingBreakdown(),
        lastSync: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
        sessions: Object.values(activeSessionsMap),
        recentLog: monitorLog.slice(0, 30)
    };
    const blob = new Blob([JSON.stringify(diag, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Rio_Monitor_Diag_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    logMonitorEvent("system", "Diagnostics exported");
    showToast("Diagnostics downloaded");
}

function clearLocalCacheOnly() {
    if (!confirm("Clear all local cached bills/users and pending queues?\nCloud data stays safe.")) return;
    [LS.BILLS, LS.USERS, LS.PENDING_BILLS, LS.PENDING_USERS, LS.PENDING_BILL_OPS, LS.DELETED_BILLS].forEach((k) => {
        localStorage.removeItem(k);
    });
    cachedBills = [];
    cachedUsers = [];
    logMonitorEvent("cache", "Local cache cleared");
    showToast("Local cache cleared");
    refreshMonitorBoard();
    refreshCurrentViews();
}

document.getElementById("devRefreshAnalyticsBtn")?.addEventListener("click", refreshMonitorBoard);
document.getElementById("monitorRefreshBtn")?.addEventListener("click", async () => {
    await refreshConnectionStatus();
    refreshMonitorBoard();
    logMonitorEvent("system", "Manual refresh");
});
document.getElementById("devStorageSyncBtn")?.addEventListener("click", () => syncAll(true));
document.getElementById("devStorageLogoutAllBtn")?.addEventListener("click", () => forceLogoutAllUsers());
document.getElementById("devStorageRefreshConnBtn")?.addEventListener("click", async () => {
    logMonitorEvent("action", "Refreshing network…");
    await refreshConnectionStatus();
    refreshMonitorBoard();
});
document.getElementById("monitorFixConnBtn")?.addEventListener("click", monitorFixConnection);
document.getElementById("devClearLocalCacheBtn")?.addEventListener("click", clearLocalCacheOnly);
document.getElementById("monitorClearLogBtn")?.addEventListener("click", () => {
    monitorLog = [];
    renderMonitorLog();
});
document.getElementById("monitorExportDiagBtn")?.addEventListener("click", exportMonitorDiagnostics);

// ─── Admin ───
let adminReportFiltered = [];

const ADMIN_REPORT_FILTER_IDS = {
    type: "adminReportFilterType", date: "adminReportDate", from: "adminReportFrom",
    to: "adminReportTo", month: "adminReportMonth", year: "adminReportYear"
};

const ADMIN_LEDGER_FILTER_IDS = {
    type: "adminLedgerFilterType", date: "adminLedgerDate", from: "adminLedgerFrom",
    to: "adminLedgerTo", month: "adminLedgerMonth", year: "adminLedgerYear"
};

const DEV_LEDGER_FILTER_IDS = {
    type: "devLedgerFilterType", date: "devLedgerDate", from: "devLedgerFrom",
    to: "devLedgerTo", month: "devLedgerMonth", year: "devLedgerYear"
};

function initAdminLedgerFilterDefaults() {
    const today = new Date().toISOString().split("T")[0];
    const monthEl = document.getElementById("adminLedgerMonth");
    const yearEl = document.getElementById("adminLedgerYear");
    const dateEl = document.getElementById("adminLedgerDate");
    if (monthEl) monthEl.value = today.slice(0, 7);
    if (yearEl) yearEl.value = today.slice(0, 4);
    if (dateEl) dateEl.value = today;
    const typeEl = document.getElementById("adminLedgerFilterType");
    if (typeEl) typeEl.value = "today";
    updateAdminLedgerFilterUI();
    syncAdminLedgerQuickBtns();
}

function updateAdminLedgerFilterUI() {
    toggleFilterRows("adminLedgerFilterType", {
        month: "adminLedgerMonthRow", year: "adminLedgerYearRow",
        date: "adminLedgerDateRow", range: "adminLedgerRangeRow"
    });
}

function syncAdminLedgerQuickBtns() {
    const type = document.getElementById("adminLedgerFilterType")?.value || "today";
    document.querySelectorAll("[data-ledger-filter]").forEach((btn) => {
        const match = btn.dataset.ledgerFilter;
        btn.classList.toggle("active", match === type && (match === "today" || match === "all" || match === "month"));
    });
}

function getFilteredAdminLedgerBills(cloud) {
    const all = mergeBills(cloud);
    const state = readFilterState(ADMIN_LEDGER_FILTER_IDS);
    if (state.type === "range" && !isRangeFilterReady(state)) return [];
    let filtered = filterBillsByPeriod(all, state);
    if (filtered === null) filtered = [];
    return filtered;
}

function setAdminLedgerFilter(type) {
    const typeEl = document.getElementById("adminLedgerFilterType");
    if (typeEl) typeEl.value = type;
    if (type === "month") {
        const today = new Date().toISOString().split("T")[0];
        const monthEl = document.getElementById("adminLedgerMonth");
        if (monthEl) monthEl.value = today.slice(0, 7);
    }
    updateAdminLedgerFilterUI();
    syncAdminLedgerQuickBtns();
    refreshAdminBillsView();
}

function initDevLedgerFilterDefaults() {
    const today = new Date().toISOString().split("T")[0];
    const monthEl = document.getElementById("devLedgerMonth");
    const yearEl = document.getElementById("devLedgerYear");
    const dateEl = document.getElementById("devLedgerDate");
    if (monthEl) monthEl.value = today.slice(0, 7);
    if (yearEl) yearEl.value = today.slice(0, 4);
    if (dateEl) dateEl.value = today;
    const typeEl = document.getElementById("devLedgerFilterType");
    if (typeEl) typeEl.value = "today";
    updateDevLedgerFilterUI();
    syncDevLedgerQuickBtns();
}

function updateDevLedgerFilterUI() {
    toggleFilterRows("devLedgerFilterType", {
        month: "devLedgerMonthRow", year: "devLedgerYearRow",
        date: "devLedgerDateRow", range: "devLedgerRangeRow"
    });
}

function syncDevLedgerQuickBtns() {
    const type = document.getElementById("devLedgerFilterType")?.value || "today";
    document.querySelectorAll("[data-dev-ledger-filter]").forEach((btn) => {
        const match = btn.dataset.devLedgerFilter;
        btn.classList.toggle("active", match === type && (match === "today" || match === "all" || match === "month"));
    });
}

function getFilteredDevBills(cloud) {
    let bills = mergeBills(cloud);
    const designerFilter = document.getElementById("devDesignerFilter");
    if (designerFilter && designerFilter.value && designerFilter.value !== "all") {
        bills = filterBillsByDesigner(bills, designerFilter.value);
    }
    const state = readFilterState(DEV_LEDGER_FILTER_IDS);
    if (state.type === "range" && !isRangeFilterReady(state)) return [];
    let filtered = filterBillsByPeriod(bills, state);
    if (filtered === null) filtered = [];
    return filtered;
}

function setDevLedgerFilter(type) {
    const typeEl = document.getElementById("devLedgerFilterType");
    if (typeEl) typeEl.value = type;
    if (type === "month") {
        const today = new Date().toISOString().split("T")[0];
        const monthEl = document.getElementById("devLedgerMonth");
        if (monthEl) monthEl.value = today.slice(0, 7);
    }
    updateDevLedgerFilterUI();
    syncDevLedgerQuickBtns();
    refreshDevBillsView();
}

function initAdminReportDefaults() {
    const today = new Date().toISOString().split("T")[0];
    const monthEl = document.getElementById("adminReportMonth");
    const yearEl = document.getElementById("adminReportYear");
    const dateEl = document.getElementById("adminReportDate");
    if (monthEl) monthEl.value = today.slice(0, 7);
    if (yearEl) yearEl.value = today.slice(0, 4);
    if (dateEl) dateEl.value = today;
    updateAdminReportFilterUI();
}

function updateAdminReportFilterUI() {
    toggleFilterRows("adminReportFilterType", {
        month: "adminReportMonthRow", year: "adminReportYearRow",
        date: "adminReportDateRow", range: "adminReportRangeRow"
    });
}

function applyAdminReportFilter() {
    if (!currentUser || currentUser.role !== "admin") return;
    updateAdminReportFilterUI();
    const allBills = mergeBills(undefined);
    populateDesignerFilter(document.getElementById("adminReportDesigner"), allBills);
    const designer = document.getElementById("adminReportDesigner")?.value || "all";
    const state = readFilterState(ADMIN_REPORT_FILTER_IDS);
    if (state.type === "range" && !isRangeFilterReady(state)) {
        adminReportFiltered = [];
        document.getElementById("adminReportTitle").textContent = "Pick date range";
        renderAdminReportTable([]);
        return;
    }
    let bills = filterBillsByPeriod(allBills, state);
    if (bills === null) bills = [];
    if (designer !== "all") bills = filterBillsByDesigner(bills, designer);
    adminReportFiltered = bills;
    const label = getPeriodLabel(state, designer === "all" ? null : designer);
    document.getElementById("adminReportTitle").textContent = label;
    renderAdminReportTable(bills);
}

function renderAdminReportTable(bills) {
    let grand = 0, priceSum = 0, designSum = 0;
    const tbody = document.getElementById("adminReportBody");
    if (!tbody) return;
    tbody.innerHTML = bills.length === 0
        ? `<tr><td colspan="7" class="empty-state">No bills for this filter.</td></tr>`
        : bills.map((b) => {
            const price = parseFloat(b.price || 0);
            const design = billDesignCharge(b);
            const total = billLineTotal(b);
            grand += total; priceSum += price; designSum += design;
            const desc = b.description ? `<span class="desc-col" title="${escAttr(b.description)}">${b.description}</span>` : "—";
            return `<tr>
                <td>${b.date || "—"}</td>
                <td><strong>${b.billNo || "—"}</strong></td>
                <td><span class="role-badge designer">${b.username || "—"}</span></td>
                <td>${desc}</td>
                <td class="money-col">${formatMoney(price)}</td>
                <td class="money-sub">${design > 0 ? formatMoney(design) : "—"}</td>
                <td class="money-col total-col">${formatMoney(total)}</td>
            </tr>`;
        }).join("");
    document.getElementById("adminReportTableTotal").textContent = "Rs. " + formatMoney(grand);
}

function exportAdminReportPDF() {
    const designer = document.getElementById("adminReportDesigner")?.value || "all";
    const state = readFilterState(ADMIN_REPORT_FILTER_IDS);
    const periodLabel = getPeriodLabel(state, designer === "all" ? null : designer);
    exportBillsToPDF(adminReportFiltered, {
        subtitle: "Admin Designer Report",
        designerLine: designer === "all" ? "All Designers" : `Designer: ${designer}`,
        periodLabel,
        filenamePrefix: "AdminReport",
        showDesigner: true
    });
}

function initAdminDashboard() {
    document.getElementById("adminDisplayName").textContent = currentUser.username;
    document.getElementById("adminAvatar").textContent = currentUser.username.charAt(0).toUpperCase();
    initAdminReportDefaults();
    initAdminLedgerFilterDefaults();
    if (firebaseReady) {
        subscribeAdminBills();
        subscribeAdminUsers();
        subscribeActiveSessions();
    } else {
        refreshAdminBillsView();
        renderAdminUsers(getCachedUsers());
        applyAdminReportFilter();
    }
}

function subscribeAdminBills() {
    adminBillsUnsub = db.collection("bills").onSnapshot((snap) => {
        const bills = []; snap.forEach((d) => bills.push({ id: d.id, ...d.data() }));
        const merged = applyServerBillsToCache(bills);
        refreshAdminBillsView(merged);
        applyAdminReportFilter();
    }, () => { refreshAdminBillsView(); applyAdminReportFilter(); });
}

function refreshAdminBillsView(cloud) {
    const billsToRender = getFilteredAdminLedgerBills(cloud);
    updateAnalyticsCards(billsToRender, "adminTotalRevenue", "adminBillCount", "adminDesignerCount");
    renderBillsTable("adminBillsBody", billsToRender, {
        showDesigner: true, showActions: false, showUpdated: true,
        totalIds: { revenue: "adminTotalRevenue", table: "adminTableTotal", count: "adminBillCount" }
    });
    if (document.getElementById("adminReportsPanel")?.classList.contains("active")) applyAdminReportFilter();
}

function subscribeAdminUsers() {
    adminUsersUnsub = db.collection("users").onSnapshot((snap) => {
        const users = []; snap.forEach((d) => users.push({ id: d.id, ...d.data() }));
        cacheUsers(users); renderAdminUsers(users);
    }, () => renderAdminUsers(getCachedUsers()));
}

function renderAdminUsers(users) {
    const tbody = document.getElementById("adminUsersBody");
    document.getElementById("adminDesignerCount").textContent = users.filter((u) => u.role === "designer").length;
    if (!users.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No users.</td></tr>`; return; }
    tbody.innerHTML = users.filter((u) => u.role !== "developer").map((u) => {
        const presence = getUserPresenceInfo(u);
        const actions = u.role === "admin" ? `<span style="color:var(--text-muted);font-size:11px;">Protected</span>`
            : `<div class="btn-action-group">
                <button class="btn-action edit" data-action="edit" data-id="${u.id}" data-name="${u.username}">Password</button>
                <button class="btn-action delete" data-action="delete" data-id="${u.id}" data-name="${u.username}">Remove</button></div>`;
        return `<tr>
            <td><strong>${u.username}</strong></td>
            <td><span class="role-badge ${u.role}">${u.role}</span></td>
            <td>${sessionStatusCell(presence)}</td>
            <td class="session-time">${presence.lastSeen}</td>
            <td>${actions}</td></tr>`;
    }).join("");
    tbody.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => btn.dataset.action === "edit" ? openEditModal(btn.dataset.id, btn.dataset.name) : openDeleteModal(btn.dataset.id, btn.dataset.name));
    });
}

// ─── User modals (PASSWORD ONLY) ───
const userModal = document.getElementById("userModal");
const deleteModal = document.getElementById("deleteModal");

function openEditModal(userId, username) {
    document.getElementById("editUserId").value = userId;
    document.getElementById("editUsername").value = username;
    document.getElementById("editPassword").value = "";
    document.getElementById("editPasswordConfirm").value = "";
    document.getElementById("adminConfirmPassword").value = "";
    showModalError(document.getElementById("userModalError"), "");
    userModal.classList.remove("hidden");
}

function openDeleteModal(userId, username) {
    document.getElementById("deleteUserId").value = userId;
    document.getElementById("deleteUserName").textContent = username;
    document.getElementById("deleteAdminPassword").value = "";
    showModalError(document.getElementById("deleteModalError"), "");
    deleteModal.classList.remove("hidden");
}

function closeUserModals() { userModal.classList.add("hidden"); deleteModal.classList.add("hidden"); }
["userModalClose", "userModalCancel", "deleteModalClose", "deleteModalCancel"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", closeUserModals);
});

document.getElementById("userModalSave").addEventListener("click", async () => {
    const errEl = document.getElementById("userModalError");
    const userId = document.getElementById("editUserId").value;
    const username = document.getElementById("editUsername").value;
    const newPassword = document.getElementById("editPassword").value;
    const confirmPw = document.getElementById("editPasswordConfirm").value;
    const adminPw = document.getElementById("adminConfirmPassword").value;

    if (!newPassword || newPassword.length < 4) { showModalError(errEl, "Password must be at least 4 characters."); return; }
    if (newPassword !== confirmPw) { showModalError(errEl, "Passwords do not match."); return; }
    if (!adminPw) { showModalError(errEl, "Admin password required."); return; }
    if (!(await verifyAdminPasswordOnline(adminPw))) { showModalError(errEl, "Wrong admin password."); return; }

    if (firebaseReady && serverConnected) {
        try {
            await db.collection("users").doc(userId).update({ password: newPassword });
            await refreshUsersCacheFromServer();
            showToast(`Password updated for ${username} — all bills kept`);
            closeUserModals();
        } catch (e) { showModalError(errEl, getFriendlyError(e)); }
    } else {
        getPendingUsers().push({ type: "update", userId, password: newPassword });
        savePendingUsers(getPendingUsers());
        cacheUsers(getCachedUsers().map((u) => u.id === userId ? { ...u, password: newPassword } : u));
        renderAdminUsers(getCachedUsers());
        showToast("Password saved offline — bills unchanged");
        closeUserModals(); updateNetworkUI();
    }
});

document.getElementById("deleteModalConfirm").addEventListener("click", async () => {
    const errEl = document.getElementById("deleteModalError");
    const userId = document.getElementById("deleteUserId").value;
    const username = document.getElementById("deleteUserName").textContent;
    const adminPw = document.getElementById("deleteAdminPassword").value;
    if (!adminPw) { showModalError(errEl, "Admin password required."); return; }
    if (!(await verifyAdminPasswordOnline(adminPw))) { showModalError(errEl, "Wrong admin password."); return; }

    if (firebaseReady && serverConnected) {
        try {
            await removeUserCompletely(userId, username);
            showToast(`Designer "${username}" and all bills removed`);
            closeUserModals();
        } catch (e) { showModalError(errEl, getFriendlyError(e)); }
    } else {
        try {
            await removeUserCompletely(userId, username);
            showToast(`"${username}" removed offline — bills cleared locally`);
            closeUserModals();
        } catch (e) { showModalError(errEl, getFriendlyError(e)); }
    }
});

document.getElementById("addDesignerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("newDesignerUsername").value.trim();
    const password = document.getElementById("newDesignerPassword").value;
    const confirmPw = document.getElementById("newDesignerPasswordConfirm").value;
    const adminPw = document.getElementById("addAdminPassword").value;
    if (!username || !password) { showToast("Fill all fields", true); return; }
    if (password.length < 4) { showToast("Password min 4 chars", true); return; }
    if (password !== confirmPw) { showToast("Passwords do not match", true); return; }
    if (!adminPw) { showToast("Admin password required", true); return; }
    if (!(await verifyAdminPasswordOnline(adminPw))) { showToast("Wrong admin password", true); return; }
    if (getCachedUsers().some((u) => u.username === username)) { showToast("Username exists", true); return; }

    if (firebaseReady && serverConnected) {
        try {
            await db.collection("users").doc(username).set({ username, password, role: "designer" });
            await refreshUsersCache();
            document.getElementById("addDesignerForm").reset();
            showToast(`Designer "${username}" added`);
        } catch (err) { showToast(getFriendlyError(err), true); }
    } else {
        getPendingUsers().push({ type: "add", username, password, role: "designer" });
        savePendingUsers(getPendingUsers());
        cacheUsers([...getCachedUsers(), { id: username, username, password, role: "designer" }]);
        renderAdminUsers(getCachedUsers());
        document.getElementById("addDesignerForm").reset();
        showToast("Added offline"); updateNetworkUI();
    }
});

// ─── Designer CAPS lock ───
const DESIGNER_CAPS_INPUT_IDS = ["billNo", "billDescription", "editBillNo", "editBillDescription"];
let designerCapsOn = false;

function loadDesignerCapsPref() {
    try { return localStorage.getItem(LS.DESIGNER_CAPS) === "1"; } catch { return false; }
}

function saveDesignerCapsPref(on) {
    try { localStorage.setItem(LS.DESIGNER_CAPS, on ? "1" : "0"); } catch { /* ignore */ }
}

function applyDesignerCapsText(value) {
    const s = String(value ?? "");
    return isDesignerCapsActive() ? s.toUpperCase() : s;
}

function isDesignerCapsActive() {
    return designerCapsOn && currentUser?.role === "designer";
}

function enforceDesignerCapsOnInput(el) {
    if (!isDesignerCapsActive() || !el || el.type === "number" || el.type === "date") return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const upper = el.value.toUpperCase();
    if (el.value !== upper) {
        el.value = upper;
        if (start != null && end != null) el.setSelectionRange(start, end);
    }
}

function applyDesignerCapsToAllFields() {
    if (!isDesignerCapsActive()) return;
    DESIGNER_CAPS_INPUT_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el?.value) el.value = el.value.toUpperCase();
    });
}

function updateDesignerCapsUI() {
    const section = document.getElementById("designerSection");
    const toggle = document.getElementById("designerCapsToggle");
    if (toggle) toggle.checked = designerCapsOn;
    section?.classList.toggle("caps-mode", isDesignerCapsActive());
    document.getElementById("billEditModal")?.classList.toggle("caps-mode", isDesignerCapsActive());
}

function initDesignerCapsLock() {
    designerCapsOn = loadDesignerCapsPref();
    updateDesignerCapsUI();
    applyDesignerCapsToAllFields();

    document.getElementById("designerCapsToggle")?.addEventListener("change", (e) => {
        designerCapsOn = !!e.target.checked;
        saveDesignerCapsPref(designerCapsOn);
        updateDesignerCapsUI();
        if (designerCapsOn) applyDesignerCapsToAllFields();
    });

    DESIGNER_CAPS_INPUT_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("input", () => enforceDesignerCapsOnInput(el));
        el.addEventListener("paste", () => requestAnimationFrame(() => enforceDesignerCapsOnInput(el)));
    });
}

// ─── Designer ───
let designerExportFiltered = [];

const EXPORT_FILTER_IDS = { type: "exportFilterType", date: "exportSingleDate", from: "exportDateFrom", to: "exportDateTo", month: "exportMonth" };
const LIST_FILTER_IDS = { type: "listFilterType", date: "listFilterDate", from: "listFilterFrom", to: "listFilterTo", month: "listFilterMonth", year: "listFilterYear" };

function readFilterState(ids) {
    const today = new Date().toISOString().split("T")[0];
    const typeEl = document.getElementById(ids.type);
    const type = typeEl?.value || "all";
    const dateEl = document.getElementById(ids.date);
    const fromEl = document.getElementById(ids.from);
    const toEl = document.getElementById(ids.to);
    const monthEl = document.getElementById(ids.month);
    const yearEl = ids.year ? document.getElementById(ids.year) : null;
    return {
        type,
        today,
        date: dateEl?.value || today,
        from: fromEl?.value || "",
        to: toEl?.value || "",
        month: monthEl?.value || today.slice(0, 7),
        year: String(yearEl?.value || today.slice(0, 4))
    };
}

function isRangeFilterReady(state) {
    return !!(state.from && state.to && state.from <= state.to);
}

function getPeriodLabel(state, designerName) {
    let label;
    switch (state.type) {
        case "today": label = "Today — " + state.today; break;
        case "date": label = "Date — " + state.date; break;
        case "month": label = "Month — " + state.month; break;
        case "year": label = "Year — " + state.year; break;
        case "range": label = `Range — ${state.from || "?"} to ${state.to || "?"}`; break;
        default: label = "All dates";
    }
    if (designerName && designerName !== "all") label += ` · ${designerName}`;
    return label;
}

function filterBillsByPeriod(bills, state) {
    switch (state.type) {
        case "today": return bills.filter((b) => b.date === state.today);
        case "date": return bills.filter((b) => b.date === state.date);
        case "month": return bills.filter((b) => b.date && b.date.slice(0, 7) === state.month);
        case "year": return bills.filter((b) => b.date && b.date.startsWith(state.year));
        case "range":
            if (!isRangeFilterReady(state)) return null;
            return bills.filter((b) => b.date >= state.from && b.date <= state.to);
        default: return bills;
    }
}

function toggleFilterRows(typeId, rows) {
    const type = document.getElementById(typeId)?.value || "all";
    Object.entries(rows).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle("hidden", type !== key);
        if (key === "range") el.classList.toggle("filter-range", type === "range");
    });
}

function initListFilterDefaults() {
    const today = new Date().toISOString().split("T")[0];
    const monthEl = document.getElementById("listFilterMonth");
    const yearEl = document.getElementById("listFilterYear");
    const dateEl = document.getElementById("listFilterDate");
    if (monthEl) monthEl.value = today.slice(0, 7);
    if (yearEl) yearEl.value = today.slice(0, 4);
    if (dateEl) dateEl.value = today;
    const typeEl = document.getElementById("listFilterType");
    if (typeEl) typeEl.value = "today";
    updateListFilterUI();
    syncDesignerListQuickBtns();
}

function updateListFilterUI() {
    toggleFilterRows("listFilterType", {
        month: "listFilterMonthRow", year: "listFilterYearRow",
        date: "listFilterDateRow", range: "listFilterRangeWrap"
    });
}

function syncDesignerListQuickBtns() {
    const type = document.getElementById("listFilterType")?.value || "today";
    document.querySelectorAll("[data-designer-list-filter]").forEach((btn) => {
        const match = btn.dataset.designerListFilter;
        btn.classList.toggle("active", match === type && (match === "today" || match === "all" || match === "month"));
    });
}

function setDesignerListFilter(type) {
    const typeEl = document.getElementById("listFilterType");
    if (typeEl) typeEl.value = type;
    if (type === "month") {
        const today = new Date().toISOString().split("T")[0];
        const monthEl = document.getElementById("listFilterMonth");
        if (monthEl) monthEl.value = today.slice(0, 7);
    }
    updateListFilterUI();
    syncDesignerListQuickBtns();
    refreshDesignerBillsView();
}

function updateExportFilterUI() {
    const type = document.getElementById("exportFilterType")?.value || "all";
    document.getElementById("exportDateRow")?.classList.toggle("hidden", type !== "date");
    document.getElementById("exportMonthRow")?.classList.toggle("hidden", type !== "month");
    document.getElementById("exportRangeRow")?.classList.toggle("hidden", type !== "range");
}

async function initDesignerDashboard() {
    document.getElementById("designerDisplayName").textContent = currentUser.username;
    document.getElementById("designerAvatar").textContent = currentUser.username.charAt(0).toUpperCase();
    setDefaultBillDate();
    updateBillLinePreview();
    updateDesignerCapsUI();
    initListFilterDefaults();
    const monthInput = document.getElementById("exportMonth");
    if (monthInput) monthInput.value = new Date().toISOString().slice(0, 7);
    const singleDate = document.getElementById("exportSingleDate");
    if (singleDate) singleDate.value = new Date().toISOString().split("T")[0];
    updateExportFilterUI();

    const boot = async () => {
        if (serverConnected && firebaseReady) await refreshBillsCacheFromServer().catch(() => {});
        if (firebaseReady) subscribeDesignerBills();
        else refreshDesignerViews();
        applyExportFilter();
    };
    boot();
}

function subscribeDesignerBills() {
    designerBillsUnsub = db.collection("bills").where("username", "==", currentUser.username)
        .onSnapshot((snap) => {
            const bills = []; snap.forEach((d) => bills.push({ id: d.id, ...d.data() }));
            applyServerBillsToCache(getCachedBills()
                .filter((b) => b.username !== currentUser.username)
                .concat(bills));
            refreshDesignerViews();
        }, () => refreshDesignerViews());
}

function refreshDesignerViews() {
    refreshDesignerBillsView();
    applyExportFilter();
}

function refreshDesignerBillsView() {
    const all = mergeBills(undefined, currentUser.username);
    const state = readFilterState(LIST_FILTER_IDS);
    if (state.type === "range" && !isRangeFilterReady(state)) {
        renderBillsTable("designerBillsBody", [], {
            showActions: true,
            totalIds: { revenue: "designerTotalRevenue", table: "designerTableTotal", count: "designerBillCount" }
        });
        return;
    }
    let filtered = filterBillsByPeriod(all, state);
    if (filtered === null) filtered = [];
    renderBillsTable("designerBillsBody", filtered, {
        showActions: true,
        totalIds: { revenue: "designerTotalRevenue", table: "designerTableTotal", count: "designerBillCount" }
    });
}

function getExportFilterState() { return readFilterState(EXPORT_FILTER_IDS); }
function getExportPeriodLabel(state) { return getPeriodLabel(state).replace("All dates", "All Records"); }

function applyExportFilter() {
    if (!currentUser || currentUser.role !== "designer") return;
    updateExportFilterUI();
    const state = getExportFilterState();
    if (state.type === "range" && !isRangeFilterReady(state)) {
        designerExportFiltered = [];
        document.getElementById("exportReviewTitle").textContent = "Pick date range";
        renderExportReviewTable([]);
        return;
    }
    let filtered = filterBillsByPeriod(mergeBills(undefined, currentUser.username), state);
    if (filtered === null) filtered = [];
    designerExportFiltered = filtered;
    const label = getExportPeriodLabel(state);
    document.getElementById("exportReviewTitle").textContent = label;
    renderExportReviewTable(designerExportFiltered);
}

function bindFilterField(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", handler);
    el.addEventListener("input", handler);
}

function renderExportReviewTable(bills) {
    let grand = 0, priceSum = 0, designSum = 0;
    const tbody = document.getElementById("exportReviewBody");
    if (!tbody) return;
    tbody.innerHTML = bills.length === 0
        ? `<tr><td colspan="6" class="empty-state">No bills for this filter.</td></tr>`
        : bills.map((b) => {
            const price = parseFloat(b.price || 0);
            const design = billDesignCharge(b);
            const total = billLineTotal(b);
            grand += total; priceSum += price; designSum += design;
            const desc = b.description ? `<span class="desc-col" title="${escAttr(b.description)}">${b.description}</span>` : "—";
            return `<tr>
                <td>${b.date || "—"}</td>
                <td><strong>${b.billNo || "—"}</strong></td>
                <td>${desc}</td>
                <td class="money-col">${formatMoney(price)}</td>
                <td class="money-sub">${design > 0 ? formatMoney(design) : "—"}</td>
                <td class="money-col total-col">${formatMoney(total)}</td>
            </tr>`;
        }).join("");
    const reviewTotal = document.getElementById("exportReviewTotal");
    if (reviewTotal) reviewTotal.textContent = "Rs. " + formatMoney(grand);
}

function exportBillsToPDF(bills, opts = {}) {
    if (!window.jspdf) { showToast("PDF library not loaded", true); return; }
    if (!bills.length) { showToast("No bills to export for this filter", true); return; }
    const {
        subtitle = "Bill Report",
        designerLine = currentUser ? `Designer: ${currentUser.username}` : "",
        periodLabel = "All Records",
        filenamePrefix = "Report",
        showDesigner = false
    } = opts;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: bills.length > 8 ? "landscape" : "portrait", unit: "mm", format: "a4" });

    doc.setFillColor(10, 10, 10);
    doc.rect(0, 0, doc.internal.pageSize.getWidth(), 36, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(20);
    doc.setFont(undefined, "bold");
    doc.text("Rio Studio Designers", 14, 16);
    doc.setFontSize(10);
    doc.setFont(undefined, "normal");
    doc.setTextColor(255, 80, 100);
    doc.text(subtitle, 14, 24);
    doc.setTextColor(220, 220, 220);
    doc.text(designerLine, 14, 30);
    doc.text(`Period: ${periodLabel}`, 90, 30);

    const head = showDesigner
        ? ["Date", "Bill No", "Designer", "Description", "Price", "Design", "Total"]
        : ["Date", "Bill No", "Description", "Price (Rs.)", "Design (Rs.)", "Total (Rs.)"];
    const rows = bills.map((b) => {
        const row = [
            b.date || "—",
            b.billNo || "—",
            ...(showDesigner ? [b.username || "—"] : []),
            b.description || "—",
            formatMoney(b.price),
            billDesignCharge(b) > 0 ? formatMoney(billDesignCharge(b)) : "—",
            formatMoney(billLineTotal(b))
        ];
        return row;
    });

    doc.autoTable({
        head: [head],
        body: rows,
        startY: 42,
        theme: "grid",
        headStyles: { fillColor: [204, 0, 40], textColor: 255, fontStyle: "bold", fontSize: showDesigner ? 8 : 9 },
        bodyStyles: { fontSize: 7, textColor: [30, 30, 30] },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        margin: { left: 14, right: 14 }
    });

    const finalY = doc.lastAutoTable.finalY + 8;
    const priceSum = bills.reduce((s, b) => s + parseFloat(b.price || 0), 0);
    const designSum = bills.reduce((s, b) => s + billDesignCharge(b), 0);
    const grand = priceSum + designSum;

    doc.setFontSize(10);
    doc.setTextColor(30, 30, 30);
    doc.setFont(undefined, "bold");
    doc.text(`Total Bills: ${bills.length}`, 14, finalY);
    doc.text(`Price Total: Rs. ${formatMoney(priceSum)}`, 14, finalY + 6);
    doc.text(`Design Charges: Rs. ${formatMoney(designSum)}`, 14, finalY + 12);
    doc.setFontSize(12);
    doc.setTextColor(204, 0, 40);
    doc.text(`Grand Total: Rs. ${formatMoney(grand)}`, 14, finalY + 20);
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(`Generated: ${new Date().toLocaleString("en-LK")}`, 14, finalY + 28);

    const safePeriod = periodLabel.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
    doc.save(`${filenamePrefix}_${safePeriod}.pdf`);
    showToast("PDF saved successfully");
}

function exportFilteredBillsPDF() {
    const state = getExportFilterState();
    exportBillsToPDF(designerExportFiltered, {
        subtitle: "Bill Report — Export & Review",
        designerLine: `Designer: ${currentUser.username}`,
        periodLabel: getExportPeriodLabel(state),
        filenamePrefix: `RioStudio_${currentUser.username.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    });
}

document.querySelectorAll("[data-designer-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("[data-designer-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll("#designerSection .designer-tab-panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.designerTab));
        if (btn.dataset.designerTab === "designerExportPanel") applyExportFilter();
    });
});

function openFullViewFromTable(tableId, title) {
    const source = document.getElementById(tableId);
    if (!source) return;
    const dest = document.getElementById("fullViewTable");
    dest.innerHTML = source.innerHTML;
    dest.className = source.className || "fullview-table fit-table";
    document.getElementById("fullViewTitle").textContent = title || "Table View";
    const footerBar = source.closest(".data-table-panel")?.querySelector(".table-footer-bar");
    const fvFooter = document.getElementById("fullViewFooter");
    const fvLabel = document.getElementById("fullViewFooterLabel");
    const fvTotal = document.getElementById("fullViewFooterTotal");
    if (footerBar && fvFooter && fvLabel && fvTotal) {
        fvLabel.textContent = footerBar.querySelector(".footer-label")?.textContent || "Total";
        fvTotal.textContent = footerBar.querySelector(".footer-total")?.textContent || "Rs. 0.00";
        fvFooter.classList.remove("hidden");
    } else if (fvFooter) {
        fvFooter.classList.add("hidden");
    }
    document.getElementById("fullViewModal").classList.remove("hidden");
    const tbody = dest.querySelector("tbody");
    if (tbody?.querySelector(".bill-edit-btn")) bindBillActions(tbody);
}

function closeFullView() {
    document.getElementById("fullViewModal")?.classList.add("hidden");
}

document.getElementById("fullViewClose")?.addEventListener("click", closeFullView);
document.getElementById("fullViewModal")?.addEventListener("click", (e) => {
    if (e.target.id === "fullViewModal") closeFullView();
});
document.getElementById("designerBillsFullViewBtn")?.addEventListener("click", () => {
    openFullViewFromTable("designerBillsTable", "My Bills — Full View");
});
document.getElementById("exportFullViewBtn")?.addEventListener("click", () => {
    const title = document.getElementById("exportReviewTitle")?.textContent || "Export Review";
    openFullViewFromTable("exportReviewTable", `Review — ${title}`);
});
document.getElementById("adminReportFullViewBtn")?.addEventListener("click", () => {
    const title = document.getElementById("adminReportTitle")?.textContent || "Designer Report";
    openFullViewFromTable("adminReportTable", `Report — ${title}`);
});

document.getElementById("adminReportPdfBtn")?.addEventListener("click", exportAdminReportPDF);
document.getElementById("adminReportFilterType")?.addEventListener("change", applyAdminReportFilter);
document.getElementById("adminReportDesigner")?.addEventListener("change", applyAdminReportFilter);
["adminReportMonth", "adminReportYear", "adminReportDate", "adminReportFrom", "adminReportTo"].forEach((id) => {
    bindFilterField(id, applyAdminReportFilter);
});

document.getElementById("adminLedgerTodayBtn")?.addEventListener("click", () => setAdminLedgerFilter("today"));
document.getElementById("adminLedgerMonthBtn")?.addEventListener("click", () => setAdminLedgerFilter("month"));
document.getElementById("adminLedgerAllBtn")?.addEventListener("click", () => setAdminLedgerFilter("all"));
document.getElementById("adminLedgerFilterType")?.addEventListener("change", () => {
    updateAdminLedgerFilterUI();
    syncAdminLedgerQuickBtns();
    refreshAdminBillsView();
});
["adminLedgerMonth", "adminLedgerYear", "adminLedgerDate", "adminLedgerFrom", "adminLedgerTo"].forEach((id) => {
    bindFilterField(id, () => { syncAdminLedgerQuickBtns(); refreshAdminBillsView(); });
});

document.getElementById("devLedgerTodayBtn")?.addEventListener("click", () => setDevLedgerFilter("today"));
document.getElementById("devLedgerMonthBtn")?.addEventListener("click", () => setDevLedgerFilter("month"));
document.getElementById("devLedgerAllBtn")?.addEventListener("click", () => setDevLedgerFilter("all"));
document.getElementById("devLedgerFilterType")?.addEventListener("change", () => {
    updateDevLedgerFilterUI();
    syncDevLedgerQuickBtns();
    refreshDevBillsView();
});
document.getElementById("devDesignerFilter")?.addEventListener("change", () => refreshDevBillsView());
["devLedgerMonth", "devLedgerYear", "devLedgerDate", "devLedgerFrom", "devLedgerTo"].forEach((id) => {
    bindFilterField(id, () => { syncDevLedgerQuickBtns(); refreshDevBillsView(); });
});

document.getElementById("devSelectAllBills")?.addEventListener("change", (e) => {
    if (e.target.checked) devDisplayedBills.forEach((b) => devSelectedBills.add(billSelectKey(b)));
    else devDisplayedBills.forEach((b) => devSelectedBills.delete(billSelectKey(b)));
    refreshDevBillsView();
});
document.getElementById("devSelectAllHeader")?.addEventListener("change", (e) => {
    const allBox = document.getElementById("devSelectAllBills");
    if (allBox) allBox.checked = e.target.checked;
    if (e.target.checked) devDisplayedBills.forEach((b) => devSelectedBills.add(billSelectKey(b)));
    else devDisplayedBills.forEach((b) => devSelectedBills.delete(billSelectKey(b)));
    refreshDevBillsView();
});
document.getElementById("devDeleteSelectedBtn")?.addEventListener("click", () => deleteSelectedDevBills());
document.getElementById("devClearSelectionBtn")?.addEventListener("click", () => {
    devSelectedBills.clear();
    refreshDevBillsView();
});
document.getElementById("devLogoutAllBtn")?.addEventListener("click", () => forceLogoutAllUsers());

document.getElementById("exportFilterType")?.addEventListener("change", applyExportFilter);
document.getElementById("exportPdfBtn")?.addEventListener("click", exportFilteredBillsPDF);
["exportSingleDate", "exportDateFrom", "exportDateTo", "exportMonth"].forEach((id) => {
    bindFilterField(id, applyExportFilter);
});

document.getElementById("designerListTodayBtn")?.addEventListener("click", () => setDesignerListFilter("today"));
document.getElementById("designerListMonthBtn")?.addEventListener("click", () => setDesignerListFilter("month"));
document.getElementById("designerListAllBtn")?.addEventListener("click", () => setDesignerListFilter("all"));
document.getElementById("listFilterType")?.addEventListener("change", () => {
    updateListFilterUI();
    syncDesignerListQuickBtns();
    refreshDesignerBillsView();
});
["listFilterMonth", "listFilterYear", "listFilterDate", "listFilterFrom", "listFilterTo"].forEach((id) => {
    bindFilterField(id, () => { syncDesignerListQuickBtns(); refreshDesignerBillsView(); });
});

["billPrice", "billDesignCharge"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateBillLinePreview);
});

document.getElementById("billForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const date = document.getElementById("billDate").value;
    const billNo = applyDesignerCapsText(document.getElementById("billNo").value.trim());
    const description = applyDesignerCapsText(document.getElementById("billDescription").value.trim());
    const price = parseFloat(document.getElementById("billPrice").value);
    const { designCharge } = normalizeBillInput(description, document.getElementById("billDesignCharge").value);
    if (!date || !billNo || !description || isNaN(price) || price < 0) { showToast("Fill all required fields", true); return; }
    const saveBtn = document.getElementById("saveBillBtn");
    saveBtn.disabled = true; saveBtn.textContent = "Saving...";
    const billData = {
        localId: localId(), date, billNo, description, price, designCharge,
        username: currentUser.username, createdAt: new Date().toISOString(), _pending: true
    };

    if (firebaseReady && serverConnected) {
        try {
            const ref = db.collection("bills").doc(billData.localId);
            await retryOperation(() => ref.set({
                date, billNo, description, price, designCharge,
                username: currentUser.username,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }), 2, 800, 10000);
            document.getElementById("billForm").reset(); setDefaultBillDate(); updateBillLinePreview();
            await refreshBillsCacheFromServer();
            refreshDesignerViews();
            showToast("Bill saved & synced");
        } catch {
            addPendingBill(billData);
            document.getElementById("billForm").reset(); setDefaultBillDate(); updateBillLinePreview();
            refreshDesignerViews();
            showToast("Saved locally — will upload when online");
        }
    } else {
        addPendingBill(billData);
        document.getElementById("billForm").reset(); setDefaultBillDate(); updateBillLinePreview();
        refreshDesignerViews();
        showToast("Saved locally — will upload when online");
    }
    saveBtn.disabled = false; saveBtn.textContent = "Save Bill"; updateNetworkUI();
});

// ─── Developer Panel ───
function initDeveloperDashboard() {
    initDevLedgerFilterDefaults();
    if (firebaseReady) {
        subscribeDevBills();
        subscribeDevUsers();
        subscribeActiveSessions();
    } else {
        refreshDevBillsView();
        renderDevUsers(getCachedUsers());
    }
}

function subscribeDevSessions() {
    subscribeActiveSessions();
}

function subscribeDevBills() {
    devBillsUnsub = db.collection("bills").onSnapshot((snap) => {
        const bills = []; snap.forEach((d) => bills.push({ id: d.id, ...d.data() }));
        const merged = applyServerBillsToCache(bills);
        refreshDevBillsView(merged);
    }, () => refreshDevBillsView());
}

function subscribeDevUsers() {
    devUsersUnsub = db.collection("users").onSnapshot((snap) => {
        const users = []; snap.forEach((d) => users.push({ id: d.id, ...d.data() }));
        cacheUsers(users); renderDevUsers(users);
    }, () => renderDevUsers(getCachedUsers()));
}

function refreshDevBillsView(cloud) {
    const allBills = mergeBills(cloud);
    const devDesignerFilter = document.getElementById("devDesignerFilter");
    if (devDesignerFilter) populateDesignerFilter(devDesignerFilter, allBills);

    const billsToRender = getFilteredDevBills(cloud);
    updateAnalyticsCards(billsToRender, "devTotalRevenue", "devBillCount", null);

    renderDevBillsTable(billsToRender);
}

function openDevPasswordModal(userId, username) {
    document.getElementById("devEditUserId").value = userId;
    document.getElementById("devEditUsername").value = username;
    document.getElementById("devEditPassword").value = "";
    document.getElementById("devEditPasswordConfirm").value = "";
    showModalError(document.getElementById("devPasswordModalError"), "");
    document.getElementById("devPasswordModal").classList.remove("hidden");
}

function closeDevPasswordModal() {
    document.getElementById("devPasswordModal").classList.add("hidden");
}

function renderDevUsers(users) {
    const tbody = document.getElementById("devUsersBody");
    document.getElementById("devUserCount").textContent = users.length;
    if (!users.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No users.</td></tr>`; return; }
    tbody.innerHTML = users.map((u) => {
        const protected_ = u.role === "developer";
        const presence = getUserPresenceInfo(u);
        const pwCell = `<code class="dev-password-cell dev-pw-cell" data-id="${u.id}" data-name="${escAttr(u.username)}" title="Click to change password">${escAttr(u.password || "—")}</code>`;
        const isLoggedIn = !!activeSessionsMap[u.id];
        const actions = protected_
            ? `<span style="color:var(--text-muted);font-size:11px;">Protected</span>`
            : `<div class="btn-action-group">
                <button type="button" class="btn-action dev-login-btn" data-id="${u.id}" data-name="${escAttr(u.username)}" data-role="${u.role}">Login As</button>
                <button type="button" class="btn-action dev-force-logout-btn" data-id="${u.id}" data-name="${escAttr(u.username)}"${isLoggedIn ? "" : " disabled"}>Logout</button>
                <button type="button" class="btn-action edit dev-pw-btn" data-id="${u.id}" data-name="${escAttr(u.username)}">Password</button>
                <button type="button" class="btn-action delete dev-del-btn" data-id="${u.id}" data-name="${escAttr(u.username)}">Delete</button></div>`;
        return `<tr><td><strong>${u.username}</strong></td>
            <td><span class="role-badge ${u.role}">${u.role}</span></td>
            <td>${pwCell}</td>
            <td>${sessionStatusCell(presence)}</td>
            <td class="session-time">${presence.lastSeen}</td>
            <td>${actions}</td></tr>`;
    }).join("");

    tbody.querySelectorAll(".dev-login-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            loginAsUser({ id: btn.dataset.id, username: btn.dataset.name, role: btn.dataset.role });
        });
    });
    tbody.querySelectorAll(".dev-force-logout-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.disabled) return;
            if (!confirm(`Force logout "${btn.dataset.name}" on all devices?`)) return;
            forceLogoutUser(btn.dataset.id, btn.dataset.name);
        });
    });
    tbody.querySelectorAll(".dev-pw-btn, .dev-pw-cell").forEach((el) => {
        el.addEventListener("click", () => openDevPasswordModal(el.dataset.id, el.dataset.name));
    });
    tbody.querySelectorAll(".dev-del-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (!confirm(`Delete "${btn.dataset.name}" and ALL their bills permanently?`)) return;
            deleteUserDev(btn.dataset.id, btn.dataset.name);
        });
    });
}

async function updateUserPasswordDev(userId, password, username) {
    if (firebaseReady && serverConnected) {
        try {
            await db.collection("users").doc(userId).update({ password });
            await refreshUsersCache();
            showToast(`Password updated for ${username}`);
        } catch (e) { showToast(getFriendlyError(e), true); }
    } else {
        getPendingUsers().push({ type: "update", userId, password });
        savePendingUsers(getPendingUsers());
        cacheUsers(getCachedUsers().map((u) => u.id === userId ? { ...u, password } : u));
        renderDevUsers(getCachedUsers());
        showToast("Saved offline");
    }
}

async function deleteUserDev(userId, username) {
    try {
        const ok = await removeUserCompletely(userId, username);
        if (ok) showToast(`Deleted ${username} and all bills`);
    } catch (e) { showToast(getFriendlyError(e), true); }
}

["devPasswordModalClose", "devPasswordModalCancel"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", closeDevPasswordModal);
});

document.getElementById("devPasswordModalSave")?.addEventListener("click", async () => {
    const errEl = document.getElementById("devPasswordModalError");
    const userId = document.getElementById("devEditUserId").value;
    const username = document.getElementById("devEditUsername").value;
    const newPassword = document.getElementById("devEditPassword").value;
    const confirmPw = document.getElementById("devEditPasswordConfirm").value;

    if (!newPassword || newPassword.length < 4) {
        showModalError(errEl, "Password must be at least 4 characters.");
        return;
    }
    if (newPassword !== confirmPw) {
        showModalError(errEl, "Passwords do not match.");
        return;
    }

    try {
        await updateUserPasswordDev(userId, newPassword, username);
        closeDevPasswordModal();
    } catch (e) {
        showModalError(errEl, getFriendlyError(e));
    }
});

document.getElementById("devAddUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("devNewUsername").value.trim();
    const password = document.getElementById("devNewPassword").value;
    const role = document.getElementById("devNewRole").value;
    if (!username || password.length < 4) { showToast("Fill all fields", true); return; }
    if (getCachedUsers().some((u) => u.username === username)) { showToast("Username exists", true); return; }

    if (firebaseReady && serverConnected) {
        try {
            await db.collection("users").doc(username).set({ username, password, role });
            await refreshUsersCache();
            document.getElementById("devAddUserForm").reset();
            showToast(`User "${username}" created`);
        } catch (err) { showToast(getFriendlyError(err), true); }
    } else {
        getPendingUsers().push({ type: "add", username, password, role });
        savePendingUsers(getPendingUsers());
        cacheUsers([...getCachedUsers(), { id: username, username, password, role }]);
        renderDevUsers(getCachedUsers());
        document.getElementById("devAddUserForm").reset();
        showToast("Added offline");
    }
});

// ─── Network & Init ───
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && window.rioNet) {
        window.rioNet.getStatus().then(applyNetworkStatus);
    }
});

async function initDefaultAccounts() {
    const accounts = [
        { id: "admin", username: "admin", password: "admin123", role: "admin" },
        { id: DEV_USER, username: DEV_USER, password: DEV_PASS, role: "developer" }
    ];
    for (const acc of accounts) {
        const ref = db.collection("users").doc(acc.id);
        const snap = await ref.get();
        if (!snap.exists) await ref.set({ username: acc.username, password: acc.password, role: acc.role });
    }
    await refreshUsersCache();
}

async function initApp() {
    cachedUsers = getCachedUsers();
    cachedBills = getCachedBills();
    hideAllSections();
    setLoginConnectionState("checking");

    try {
        await Promise.race([initNetworkMonitoring(), sleep(4000)]);
        if (serverConnected) {
            await verifyFirebaseConnection();
            await initDefaultAccounts().catch(() => {});
            setLoginConnectionState("connected");
        } else {
            setLoginConnectionState("disconnected");
        }
        cachedUsers = getCachedUsers();
        cachedBills = getCachedBills();
        if (!tryRestoreSession()) showSection(loginSection);
    } catch (err) {
        console.error("App init error:", err);
        setLoginConnectionState("disconnected");
        if (!currentUser) showSection(loginSection);
    } finally {
        hideLoadingScreen();
        updateNetworkUI();
        logMonitorEvent("system", `App ready v${APP_VERSION} — ${serverConnected ? "online" : "offline"} mode`);
        maybeShowWelcomePatchNotes();
    }
}

function shouldShowWelcomePatchNotes() {
    try { return localStorage.getItem(PATCH_DISMISS_KEY) !== "1"; } catch { return true; }
}

function maybeShowWelcomePatchNotes() {
    if (!shouldShowWelcomePatchNotes()) return;
    const modal = document.getElementById("patchNotesModal");
    if (!modal) return;
    setTimeout(() => {
        modal.classList.add("patch-welcome");
        modal.classList.remove("hidden");
    }, 450);
}

initApp();
initDesignerCapsLock();

/* ─── Auto-Update UI Logic ─── */
(function initAutoUpdater() {
    if (!window.rioUpdater) return;

    const updateModal = document.getElementById("updateModal");
    const updateProgressBar = document.getElementById("updateProgressBar");
    const updateStatusText = document.getElementById("updateStatusText");
    const updateVersionText = document.getElementById("updateVersionText");
    const updateModalFooter = document.getElementById("updateModalFooter");
    const restartInstallBtn = document.getElementById("restartInstallBtn");
    const updateLaterBtn = document.getElementById("updateLaterBtn");

    function showUpdateModal() {
        if (updateModal) updateModal.classList.remove("hidden");
    }

    function hideUpdateModal() {
        if (updateModal) updateModal.classList.add("hidden");
    }

    // Listen for update checking
    window.rioUpdater.onUpdateChecking(() => {
        console.log("[Updater] Checking for updates...");
        if (updateStatusText) updateStatusText.textContent = "Checking for updates...";
        if (updateProgressBar) updateProgressBar.style.width = "0%";
    });

    // Listen for update available
    window.rioUpdater.onUpdateAvailable((info) => {
        console.log("[Updater] Update available:", info.version);
        if (updateVersionText) updateVersionText.textContent = `Version ${info.version} is available`;
        if (updateStatusText) updateStatusText.textContent = "Downloading update...";
        if (updateProgressBar) updateProgressBar.style.width = "5%";
        showUpdateModal();
    });

    // Listen for update not available
    window.rioUpdater.onUpdateNotAvailable(() => {
        console.log("[Updater] Already up to date");
    });

    // Listen for download progress
    window.rioUpdater.onUpdateDownloadProgress((progress) => {
        const percent = Math.round(progress.percent || 0);
        console.log(`[Updater] Downloading: ${percent}%`);
        if (updateProgressBar) updateProgressBar.style.width = `${percent}%`;
        if (updateStatusText) updateStatusText.textContent = `Downloading update: ${percent}%`;
    });

    // Listen for update downloaded
    window.rioUpdater.onUpdateDownloaded((info) => {
        console.log("[Updater] Update downloaded:", info.version);
        if (updateStatusText) updateStatusText.textContent = "Update ready to install";
        if (updateProgressBar) updateProgressBar.style.width = "100%";
        if (updateModalFooter) updateModalFooter.classList.remove("hidden");
    });

    // Listen for errors
    window.rioUpdater.onUpdateError((error) => {
        console.error("[Updater] Error:", error.message);
        if (updateStatusText) updateStatusText.textContent = "Update check failed";
        showToast("Update check failed: " + (error.message || "Unknown error"), true);
    });

    // Restart & Install button
    if (restartInstallBtn) {
        restartInstallBtn.addEventListener("click", () => {
            console.log("[Updater] Restarting to install update...");
            window.rioUpdater.restartAndInstall();
        });
    }

    // Later button
    if (updateLaterBtn) {
        updateLaterBtn.addEventListener("click", () => {
            hideUpdateModal();
        });
    }
})();

/* ─── Premium UI helpers (filters, analytics, print) ─── */
function populateDesignerFilter(selectElement, bills) {
    if (!selectElement) return;
    const currentValue = selectElement.value;
    selectElement.innerHTML = '<option value="all">All</option>';
    const uniqueDesigners = [...new Set(bills.map((b) => b.username).filter(Boolean))].sort();
    uniqueDesigners.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name.toUpperCase();
        selectElement.appendChild(option);
    });
    if (uniqueDesigners.includes(currentValue)) selectElement.value = currentValue;
}

function filterBillsByDesigner(bills, designerName) {
    if (!designerName || designerName === "all") return bills;
    return bills.filter((b) => b.username === designerName);
}

function updateAnalyticsCards(bills, revenueId, billCountId, designerCountId) {
    let totalRev = 0;
    const uniqueDesigners = new Set();
    bills.forEach((b) => {
        totalRev += billLineTotal(b);
        if (b.username) uniqueDesigners.add(b.username);
    });
    const revEl = document.getElementById(revenueId);
    if (revEl) revEl.textContent = "Rs. " + formatMoney(totalRev);
    const countEl = document.getElementById(billCountId);
    if (countEl) countEl.textContent = `${bills.length} bill${bills.length !== 1 ? "s" : ""} recorded`;
    if (designerCountId) {
        const desEl = document.getElementById(designerCountId);
        if (desEl) desEl.textContent = uniqueDesigners.size;
    }
}

function printReport(title, totalAmount, subtitle = "") {
    document.getElementById("print-report-header")?.remove();
    const header = document.createElement("div");
    header.id = "print-report-header";
    header.className = "print-header";
    header.innerHTML = `
        <h1>${title}</h1>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
        <p><strong>Generated By:</strong> ${currentUser ? currentUser.username : "System"}</p>
        ${subtitle ? `<p>${subtitle}</p>` : ""}
        <p style="margin-top:10px;font-size:14px;"><strong>Total Amount:</strong> <span style="color:#e50914;">${totalAmount}</span></p>`;
    document.body.insertBefore(header, document.body.firstChild);
    window.print();
}

(function bindPremiumUiListeners() {
    document.getElementById("adminDesignerFilter")?.addEventListener("change", () => refreshAdminBillsView());
    document.getElementById("adminExportPdfBtn")?.addEventListener("click", exportAdminReportPDF);
    document.getElementById("devDesignerFilter")?.addEventListener("change", () => refreshDevBillsView());
    document.getElementById("devExportPdfBtn")?.addEventListener("click", () => {
        const filter = document.getElementById("devDesignerFilter");
        const fv = filter ? filter.value : "all";
        printReport("Rio Studio Designers — Developer Report", document.getElementById("devTotalRevenue")?.textContent || "Rs. 0.00",
            fv === "all" ? "All Data" : `Designer: ${fv.toUpperCase()}`);
    });
    document.getElementById("designerExportPdfBtn")?.addEventListener("click", () => {
        printReport("Rio Studio Designers — Personal Report", document.getElementById("designerTableTotal")?.textContent || "Rs. 0.00",
            currentUser ? `Designer: ${currentUser.username}` : "");
    });
})();

/* ─── Search Bar with Suggestions (Admin, Designer, Dev) ─── */
(function initSearchBars() {
    const SEARCH_CONFIGS = [
        { inputId: 'adminLedgerSearch', suggestionsId: 'adminLedgerSuggestions', panel: 'admin', getBills: () => mergeBills() },
        { inputId: 'designerLedgerSearch', suggestionsId: 'designerLedgerSuggestions', panel: 'designer', getBills: () => { const user = currentUser?.username; return mergeBills().filter(b => b.username === user); } },
        { inputId: 'devLedgerSearch', suggestionsId: 'devLedgerSuggestions', panel: 'dev', getBills: () => mergeBills() }
    ];

    let highlightedIndex = -1;
    let currentSuggestions = [];
    let activeConfig = null;

    function highlightText(text, query) {
        if (!query) return text;
        const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
        return text.replace(regex, '<span class="suggestion-highlight">$1</span>');
    }

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function generateSuggestions(bills, query) {
        if (!query || query.length < 2) return [];
        const lowerQuery = query.toLowerCase();
        const seen = new Set();
        const suggestions = [];

        bills.forEach(bill => {
            const billNo = (bill.billNo || '').toLowerCase();
            const description = (bill.description || '').toLowerCase();
            const designer = (bill.username || '').toLowerCase();

            if (billNo.includes(lowerQuery) && !seen.has(bill.id)) {
                seen.add(bill.id);
                suggestions.push({
                    id: bill.id,
                    main: `Bill No: ${bill.billNo}`,
                    sub: `${bill.description || 'No description'} • ${bill.date || ''}`,
                    type: 'billNo',
                    bill: bill
                });
            }
            if (description.includes(lowerQuery) && !seen.has(bill.id)) {
                seen.add(bill.id);
                suggestions.push({
                    id: bill.id,
                    main: bill.billNo,
                    sub: `${bill.description} • Rs. ${bill.price?.toFixed(2) || '0.00'}`,
                    type: 'description',
                    bill: bill
                });
            }
            if (designer.includes(lowerQuery) && !seen.has(bill.id)) {
                seen.add(bill.id);
                suggestions.push({
                    id: bill.id,
                    main: `Designer: ${bill.username}`,
                    sub: `${bill.billNo} • ${bill.description || ''}`,
                    type: 'designer',
                    bill: bill
                });
            }

            if (suggestions.length >= 8) return suggestions;
        });

        return suggestions.slice(0, 8);
    }

    function renderSuggestions(suggestionsId, suggestions, query) {
        const container = document.getElementById(suggestionsId);
        if (!container) return;

        if (!suggestions || suggestions.length === 0) {
            container.classList.remove('active');
            container.innerHTML = '';
            return;
        }

        container.innerHTML = suggestions.map((s, idx) => `
            <div class="search-suggestion-item" data-index="${idx}" data-bill-id="${s.bill.id}">
                <div class="suggestion-main">${highlightText(s.main, query)}</div>
                <div class="suggestion-sub">${highlightText(s.sub, query)}</div>
            </div>
        `).join('');

        container.classList.add('active');

        container.querySelectorAll('.search-suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index, 10);
                const selectedBill = suggestions[index];
                if (selectedBill) {
                    scrollToBill(selectedBill.bill.id);
                    hideAllSuggestions();
                }
            });

            item.addEventListener('mouseenter', () => {
                highlightedIndex = parseInt(item.dataset.index, 10);
                updateHighlight(container);
            });
        });
    }

    function updateHighlight(container) {
        container.querySelectorAll('.search-suggestion-item').forEach((item, idx) => {
            item.classList.toggle('highlighted', idx === highlightedIndex);
        });
    }

    function hideAllSuggestions() {
        document.querySelectorAll('.search-suggestions').forEach(el => {
            el.classList.remove('active');
        });
        highlightedIndex = -1;
        currentSuggestions = [];
        activeConfig = null;
    }

    function showSuggestionsForInput(input, config) {
        const query = input.value.trim();
        const bills = config.getBills();
        currentSuggestions = generateSuggestions(bills, query);
        renderSuggestions(config.suggestionsId, currentSuggestions, query);
        highlightedIndex = -1;
        activeConfig = config;
    }

    function handleSearchClick(input, config) {
        activeConfig = config;
        const query = input.value.trim();
        if (query.length >= 2) {
            showSuggestionsForInput(input, config);
        } else if (query.length > 0 && query.length < 2) {
            // Show hint for minimum characters
            const container = document.getElementById(config.suggestionsId);
            if (container) {
                container.innerHTML = '<div class="search-suggestion-item" style="cursor: default;"><div class="suggestion-main">Enter at least 2 characters</div></div>';
                container.classList.add('active');
            }
        }
    }

    function scrollToBill(billId) {
        const row = document.querySelector(`tr[data-bill-id="${billId}"]`);
        if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.style.transition = 'background-color 0.3s';
            row.style.backgroundColor = 'var(--accent-bg)';
            setTimeout(() => { row.style.backgroundColor = ''; }, 2000);
        }
    }

    SEARCH_CONFIGS.forEach(config => {
        const input = document.getElementById(config.inputId);
        if (!input) return;

        // Add click event to show suggestions when clicking the search bar
        input.addEventListener('click', (e) => {
            e.stopPropagation();
            handleSearchClick(input, config);
        });

        input.addEventListener('input', (e) => {
            showSuggestionsForInput(input, config);
        });

        input.addEventListener('focus', () => {
            activeConfig = config;
            const query = input.value.trim();
            if (query.length >= 2) {
                showSuggestionsForInput(input, config);
            }
        });

        input.addEventListener('keydown', (e) => {
            if (!currentSuggestions.length || !activeConfig) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                highlightedIndex = Math.min(highlightedIndex + 1, currentSuggestions.length - 1);
                const container = document.getElementById(activeConfig.suggestionsId);
                if (container) updateHighlight(container);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                highlightedIndex = Math.max(highlightedIndex - 1, 0);
                const container = document.getElementById(activeConfig.suggestionsId);
                if (container) updateHighlight(container);
            } else if (e.key === 'Enter' && highlightedIndex >= 0) {
                e.preventDefault();
                const selectedBill = currentSuggestions[highlightedIndex];
                if (selectedBill) {
                    scrollToBill(selectedBill.bill.id);
                    hideAllSuggestions();
                }
            } else if (e.key === 'Escape') {
                hideAllSuggestions();
                input.blur();
            }
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-bar-wrapper')) {
            hideAllSuggestions();
        }
    });
})();

/* ─── Patch Notes Modal ─── */
(function bindPatchNotesModal() {
    const modal = document.getElementById("patchNotesModal");
    const openBtn = document.getElementById("patchNotesOpenBtn");
    const closeBtn = document.getElementById("patchNotesClose");
    const closeBtnFooter = document.getElementById("patchNotesCloseBtn");
    const dismissCheck = document.getElementById("patchNotesDismissCheck");
    if (!modal || !openBtn) return;

    function closePatchNotes() {
        if (dismissCheck?.checked) {
            try { localStorage.setItem(PATCH_DISMISS_KEY, "1"); } catch { /* ignore */ }
        }
        modal.classList.add("hidden");
        modal.classList.remove("patch-welcome");
        if (dismissCheck) dismissCheck.checked = false;
    }

    function openPatchNotes() {
        modal.classList.remove("hidden");
    }

    openBtn.addEventListener("click", openPatchNotes);
    closeBtn?.addEventListener("click", closePatchNotes);
    closeBtnFooter?.addEventListener("click", closePatchNotes);
    modal.addEventListener("click", (e) => { if (e.target === modal) closePatchNotes(); });
})();

/* ─── Chat System (Designer <-> Dev) - NEW FLOATING PANEL ─── */
(function initChatSystem() {
    // New floating panel elements
    const floatingChatBtn = document.getElementById("floatingChatBtn");
    const chatPanel = document.getElementById("chatPanel");
    const chatPanelClose = document.getElementById("chatPanelClose");
    const floatingChatBadge = document.getElementById("floatingChatBadge");
    
    // Old modal elements (fallback)
    const chatModal = document.getElementById("chatModal");
    const designerChatToggleBtn = document.getElementById("designerChatToggleBtn");
    const devChatToggleBtn = document.getElementById("devChatToggleBtn");
    const chatModalClose = document.getElementById("chatModalClose");
    const chatMessagesContainer = document.getElementById("chatMessagesContainer");
    const chatMessageInput = document.getElementById("chatMessageInput");
    const chatSendBtn = document.getElementById("chatSendBtn");
    const designerChatBadge = document.getElementById("designerChatBadge");
    const devChatBadge = document.getElementById("devChatBadge");
    
    if (!chatPanel || !chatMessageInput) return;
    
    const CHAT_LS_KEY = "rio_chat_messages";
    let unreadCount = { designer: 0, dev: 0 };
    
    function getChatMessages() {
        try {
            const msgs = localStorage.getItem(CHAT_LS_KEY);
            return msgs ? JSON.parse(msgs) : [];
        } catch { return []; }
    }
    
    function saveChatMessages(messages) {
        try {
            localStorage.setItem(CHAT_LS_KEY, JSON.stringify(messages));
        } catch { /* ignore */ }
    }
    
    function formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    function renderMessages() {
        const messages = getChatMessages();
        const isDev = currentUser?.role === 'developer';
        
        if (messages.length === 0) {
            chatMessagesContainer.innerHTML = `
                <div class="chat-welcome-message">
                    <p>Welcome to the chat! Messages are visible to all designers and the developer.</p>
                </div>
            `;
            return;
        }
        
        chatMessagesContainer.innerHTML = messages.map(msg => {
            const isSent = msg.sender === currentUser?.username;
            const senderClass = isSent ? 'sent' : 'received';
            const senderName = msg.role === 'developer' ? 'Dev' : msg.sender;
            
            return `
                <div class="chat-message ${senderClass}">
                    ${!isSent ? `<div class="chat-message-sender">${senderName}</div>` : ''}
                    <div class="chat-message-bubble">${escapeHtml(msg.text)}</div>
                    <div class="chat-message-meta">${formatTime(msg.timestamp)}</div>
                </div>
            `;
        }).join('');
        
        // Scroll to bottom with smooth behavior
        setTimeout(() => {
            chatMessagesContainer.scrollTo({
                top: chatMessagesContainer.scrollHeight,
                behavior: 'smooth'
            });
        }, 50);
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    function sendMessage() {
        const text = chatMessageInput.value.trim();
        if (!text || !currentUser) return;
        
        const messages = getChatMessages();
        const newMessage = {
            id: Date.now().toString(),
            sender: currentUser.username,
            role: currentUser.role,
            text: text,
            timestamp: Date.now()
        };
        
        messages.push(newMessage);
        saveChatMessages(messages);
        chatMessageInput.value = '';
        renderMessages();
        
        // Update badges for other users (both navbar and floating)
        if (currentUser.role === 'designer') {
            unreadCount.dev = (unreadCount.dev || 0) + 1;
            updateBadge(devChatBadge, unreadCount.dev);
            updateBadge(floatingChatBadge, unreadCount.dev);
        } else if (currentUser.role === 'developer') {
            unreadCount.designer = (unreadCount.designer || 0) + 1;
            updateBadge(designerChatBadge, unreadCount.designer);
            updateBadge(floatingChatBadge, unreadCount.designer);
        }
    }
    
    function updateBadge(badgeElement, count) {
        if (!badgeElement) return;
        if (count > 0) {
            badgeElement.textContent = count > 99 ? '99+' : count;
            badgeElement.classList.remove('hidden');
        } else {
            badgeElement.classList.add('hidden');
        }
    }
    
    function openChat() {
        // Open the new slide-in panel
        chatPanel.classList.remove('hidden');
        // Small delay to allow display:block to apply before adding open class for transition
        setTimeout(() => {
            chatPanel.classList.add('open');
        }, 10);
        renderMessages();
        chatMessageInput.focus();
        
        // Clear unread count for current user and update floating badge
        if (currentUser?.role === 'designer') {
            unreadCount.designer = 0;
            updateBadge(designerChatBadge, 0);
            updateBadge(floatingChatBadge, 0);
        } else if (currentUser?.role === 'developer') {
            unreadCount.dev = 0;
            updateBadge(devChatBadge, 0);
            updateBadge(floatingChatBadge, 0);
        }
    }
    
    function closeChat() {
        chatPanel.classList.remove('open');
        // Wait for transition to finish before hiding
        setTimeout(() => {
            chatPanel.classList.add('hidden');
        }, 400);
    }
    
    function showFloatingButton() {
        if (floatingChatBtn) {
            floatingChatBtn.classList.remove('hidden');
        }
    }
    
    function hideFloatingButton() {
        if (floatingChatBtn) {
            floatingChatBtn.classList.add('hidden');
        }
    }
    
    function updateFloatingBadge() {
        let totalUnread = 0;
        if (currentUser?.role === 'designer') {
            totalUnread = unreadCount.designer;
        } else if (currentUser?.role === 'developer') {
            totalUnread = unreadCount.dev;
        }
        updateBadge(floatingChatBadge, totalUnread);
    }
    
    // Event listeners - New floating button
    if (floatingChatBtn) {
        floatingChatBtn.addEventListener('click', openChat);
    }
    
    if (chatPanelClose) {
        chatPanelClose.addEventListener('click', closeChat);
    }
    
    // Also support old navbar buttons (they now open the panel instead of modal)
    if (designerChatToggleBtn && currentUser?.role === 'designer') {
        designerChatToggleBtn.addEventListener('click', openChat);
    }
    
    if (devChatToggleBtn && currentUser?.role === 'developer') {
        devChatToggleBtn.addEventListener('click', openChat);
    }
    
    chatSendBtn?.addEventListener('click', sendMessage);
    
    chatMessageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // Close panel when clicking outside (on the overlay effect)
    document.addEventListener('click', (e) => {
        if (chatPanel && !chatPanel.contains(e.target) && !floatingChatBtn?.contains(e.target) && !chatPanel.classList.contains('hidden')) {
            closeChat();
        }
    });
    
    // Show floating button after a short delay on page load
    setTimeout(showFloatingButton, 1000);
    
    // Initial render and badge update
    renderMessages();
    updateFloatingBadge();
})();

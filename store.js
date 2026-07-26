// store.js — simple JSON-file persistence (no DB server needed, works fine on
// a phone/Pydroid3 or a small VPS). Watchlist + settings + access control + proxy.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'watchlist.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (_) {
    return { accounts: {}, settings: {}, authorized: {} };
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

let db = load();
if (!db.authorized) db.authorized = {};
if (!db.settings) db.settings = {};

// ─── Accounts ───────────────────────────────────────────────────────────────

function addAccount(username, addedBy) {
  username = username.toLowerCase().replace('@', '');
  if (db.accounts[username]) return false;
  db.accounts[username] = {
    username,
    addedBy,
    addedAt: Date.now(),
    status: 'unknown', // 'active' | 'banned' | 'unknown'
    lastChecked: null
  };
  save(db);
  return true;
}

function removeAccount(username) {
  username = username.toLowerCase().replace('@', '');
  if (!db.accounts[username]) return false;
  delete db.accounts[username];
  save(db);
  return true;
}

function listAccounts() {
  return Object.values(db.accounts);
}

function updateStatus(username, status) {
  username = username.toLowerCase().replace('@', '');
  if (!db.accounts[username]) return;
  db.accounts[username].status = status;
  db.accounts[username].lastChecked = Date.now();
  save(db);
}

// ─── Generic settings ───────────────────────────────────────────────────────

function getSetting(key, fallback) {
  return db.settings[key] !== undefined ? db.settings[key] : fallback;
}

function setSetting(key, value) {
  db.settings[key] = value;
  save(db);
}

// First account added sets a 30-day expiry window (like the card in the video).
// It's just a display value here, not enforced against actual usage.
function getExpiry() {
  if (!db.settings.expiresAt) {
    db.settings.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    save(db);
  }
  return db.settings.expiresAt;
}

// ─── Access control ─────────────────────────────────────────────────────────
// Admins come from ADMIN_TELEGRAM_IDS in .env (always full access, can't be
// revoked at runtime). Everyone else needs to be explicitly granted access,
// optionally with an expiry timestamp.

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function grantAccess(userId, expiresAt /* null = permanent */) {
  userId = String(userId);
  db.authorized[userId] = { grantedAt: Date.now(), expiresAt: expiresAt || null };
  save(db);
}

function revokeAccess(userId) {
  userId = String(userId);
  const existed = !!db.authorized[userId];
  delete db.authorized[userId];
  save(db);
  return existed;
}

// Access to the monitoring features (Add/Accounts/Status/Settings + status card).
// Separate from isAdmin on purpose — being an admin doesn't automatically show
// the monitoring UI, only the Admin Panel button.
function isMonitoringAuthorized(userId) {
  userId = String(userId);
  const entry = db.authorized[userId];
  if (!entry) return false;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    delete db.authorized[userId];
    save(db);
    return false;
  }
  return true;
}

function listAuthorized() {
  return Object.entries(db.authorized).map(([userId, v]) => ({ userId, ...v }));
}

// ─── Proxy (used as a fallback when a direct Instagram check fails) ───────────

function getProxy() {
  return db.settings.proxy || null; // { server, username, password }
}

function setProxy(proxy) {
  db.settings.proxy = proxy;
  save(db);
}

function clearProxy() {
  delete db.settings.proxy;
  save(db);
}

module.exports = {
  addAccount, removeAccount, listAccounts, updateStatus,
  getSetting, setSetting, getExpiry,
  isAdmin, grantAccess, revokeAccess, isMonitoringAuthorized, listAuthorized,
  getProxy, setProxy, clearProxy
};

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const store = require('./store');
const checker = require('./checker');
const discord = require('./discordWebhook');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN missing in .env');
  process.exit(1);
}

const MAX_ACCOUNTS = parseInt(process.env.MAX_ACCOUNTS) || 30;
let checkInterval = parseInt(process.env.CHECK_INTERVAL_MS) || 5 * 60 * 1000;

const bot = new TelegramBot(TOKEN, { polling: true });

// Per-chat "what are we waiting for" state, e.g. { action: 'add' } or
// { action: 'awaiting_duration', targetUserId: '123' } for multi-step flows.
const pending = new Map();

// ─── UI builders ────────────────────────────────────────────────────────────

function cancelMenuKeyboard(backTarget = 'main') {
  return {
    inline_keyboard: [
      [{ text: '❌ Cancel', callback_data: 'cancel' }, { text: '🌐 Main Menu', callback_data: backTarget }]
    ]
  };
}

function statusCardText() {
  const accounts = store.listAccounts();
  const banned = accounts.filter(a => a.status === 'banned').length;
  const dot = banned > 0 ? '🔴' : '🟢';
  const label = banned > 0 ? `${banned} Banned` : 'Active';
  const expiresAt = store.getExpiry();
  const expiresStr = new Date(expiresAt).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  return (
    `*Instagram Unban Monitor*\n\n` +
    `${accounts.length}/${MAX_ACCOUNTS} accounts • ${dot} ${label}\n` +
    `📅 Expires: ${expiresStr}`
  );
}

async function renderMenu(chatId, messageId, text, keyboard) {
  const opts = { chat_id: chatId, parse_mode: 'Markdown', reply_markup: keyboard };
  if (messageId) {
    opts.message_id = messageId;
    try { await bot.editMessageText(text, opts); return; } catch (_) { /* fall through to send */ }
  }
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// Main menu — what a user sees depends on their role:
//  - monitoring-authorized users see the status card + Add/Accounts/Status/Settings
//  - admins additionally see an "Admin Panel" button
//  - admins who are NOT separately authorized do NOT see the status card/accounts
//  - everyone else sees a "no access" message
async function showMainMenu(chatId, userId, messageId) {
  pending.delete(chatId);
  const admin = store.isAdmin(userId);
  const authorized = store.isMonitoringAuthorized(userId);

  if (!authorized && !admin) {
    await renderMenu(chatId, messageId, '🔒 You don\'t have access to this bot.\nAsk an admin to grant you access.', { inline_keyboard: [] });
    return;
  }

  const rows = [];
  let text;

  if (authorized) {
    text = statusCardText();
    rows.push([{ text: '✅ Add Account', callback_data: 'add' }, { text: '📅 Accounts', callback_data: 'accounts' }]);
    rows.push([{ text: '🚀 Status', callback_data: 'status' }, { text: '⚙️ Settings', callback_data: 'settings' }]);
  } else {
    text = '🛠 *Admin Panel*\n\nYou don\'t have monitoring access on this account — only admin controls.';
  }

  if (admin) {
    rows.push([{ text: '🛠 Admin Panel', callback_data: 'admin' }]);
  }

  await renderMenu(chatId, messageId, text, { inline_keyboard: rows });
}

function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Grant Access', callback_data: 'admin_grant' }, { text: '➖ Revoke Access', callback_data: 'admin_revoke' }],
      [{ text: '📋 List Access', callback_data: 'admin_list' }, { text: '🌐 Proxy Settings', callback_data: 'admin_proxy' }],
      [{ text: '🌐 Main Menu', callback_data: 'main' }]
    ]
  };
}

async function showAdminPanel(chatId, messageId) {
  pending.delete(chatId);
  await renderMenu(chatId, messageId, '🛠 *Admin Panel*\n\nManage who can use this bot, and the proxy fallback.', adminPanelKeyboard());
}

function durationKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '1 Day', callback_data: 'dur_1d' }, { text: '7 Days', callback_data: 'dur_7d' }],
      [{ text: '30 Days', callback_data: 'dur_30d' }, { text: 'Permanent', callback_data: 'dur_perm' }],
      [{ text: '✏️ Custom (minutes)', callback_data: 'dur_custom' }],
      [{ text: '❌ Cancel', callback_data: 'cancel' }]
    ]
  };
}

function proxyPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✏️ Set Proxy', callback_data: 'proxy_set' }, { text: '🗑️ Clear Proxy', callback_data: 'proxy_clear' }],
      [{ text: '🌐 Admin Panel', callback_data: 'admin' }]
    ]
  };
}

function maskedProxyText() {
  const p = store.getProxy();
  if (!p || !p.server) return '🌐 Proxy: not set (direct connection only)';
  return `🌐 Proxy: \`${p.server}\`${p.username ? ' (auth configured)' : ''}`;
}

// ─── Entry point ────────────────────────────────────────────────────────────

bot.onText(/^\/start/, (msg) => showMainMenu(msg.chat.id, msg.from.id));

// ─── Button handling ────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;

  const admin = store.isAdmin(userId);
  const authorized = store.isMonitoringAuthorized(userId);

  const monitoringActions = ['add', 'accounts', 'status', 'settings', 'set_webhook'];
  const adminActions = ['admin', 'admin_grant', 'admin_revoke', 'admin_list', 'admin_proxy',
    'proxy_set', 'proxy_clear', 'dur_1d', 'dur_7d', 'dur_30d', 'dur_perm', 'dur_custom'];

  if (monitoringActions.includes(data) && !authorized) {
    return bot.answerCallbackQuery(query.id, { text: '🔒 No access.', show_alert: true });
  }
  if (adminActions.includes(data) && !admin) {
    return bot.answerCallbackQuery(query.id, { text: '🔒 Admins only.', show_alert: true });
  }

  try {
    if (data === 'main') {
      await showMainMenu(chatId, userId, messageId);

    } else if (data === 'cancel') {
      pending.delete(chatId);
      await showMainMenu(chatId, userId, messageId);

    } else if (data === 'add') {
      const accounts = store.listAccounts();
      if (accounts.length >= MAX_ACCOUNTS) {
        await bot.answerCallbackQuery(query.id, { text: `Limit reached (${MAX_ACCOUNTS})`, show_alert: true });
        return;
      }
      pending.set(chatId, { action: 'add' });
      await renderMenu(chatId, messageId, 'Send the Instagram *username* you want to add (without @).', cancelMenuKeyboard());

    } else if (data === 'accounts') {
      const accounts = store.listAccounts();
      let text;
      if (accounts.length === 0) {
        text = 'No accounts added yet.';
      } else {
        text = '*Watched Accounts*\n\n' + accounts.map(a => {
          const dot = a.status === 'banned' ? '🔴' : a.status === 'active' ? '🟢' : '⚪';
          return `${dot} @${a.username}`;
        }).join('\n');
      }
      await renderMenu(chatId, messageId, text, cancelMenuKeyboard());

    } else if (data === 'status') {
      const accounts = store.listAccounts();
      if (accounts.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: 'No accounts to check yet — add one first.', show_alert: true });
        return;
      }
      pending.set(chatId, { action: 'status' });
      await renderMenu(chatId, messageId, 'Send the *username* you want to check right now.', cancelMenuKeyboard());

    } else if (data === 'settings') {
      const text =
        `*Settings*\n\n` +
        `⏱️ Check interval: every ${Math.round(checkInterval / 60000)} min\n` +
        `📦 Max accounts: ${MAX_ACCOUNTS}\n` +
        `🔗 Discord webhook: ${process.env.DISCORD_WEBHOOK_URL ? 'configured ✅' : 'not set ❌'}`;
      await renderMenu(chatId, messageId, text, {
        inline_keyboard: [
          [{ text: '🔗 Set Discord Webhook', callback_data: 'set_webhook' }],
          [{ text: '❌ Cancel', callback_data: 'cancel' }, { text: '🌐 Main Menu', callback_data: 'main' }]
        ]
      });

    } else if (data === 'set_webhook') {
      pending.set(chatId, { action: 'webhook_url' });
      await renderMenu(chatId, messageId, 'Send a public Discord webhook URL.\n(Channel Settings → Integrations → Webhooks → Copy URL)', cancelMenuKeyboard());

    // ─── Admin panel ───────────────────────────────────────────────────────

    } else if (data === 'admin') {
      await showAdminPanel(chatId, messageId);

    } else if (data === 'admin_grant') {
      pending.set(chatId, { action: 'grant_userid' });
      await renderMenu(chatId, messageId, 'Send the *Telegram user ID* to grant access to.\n(They can get their ID from @userinfobot)', cancelMenuKeyboard('admin'));

    } else if (data === 'admin_revoke') {
      pending.set(chatId, { action: 'revoke_userid' });
      await renderMenu(chatId, messageId, 'Send the *Telegram user ID* to revoke access from.', cancelMenuKeyboard('admin'));

    } else if (data === 'admin_list') {
      const list = store.listAuthorized();
      let text;
      if (list.length === 0) {
        text = '📋 *Access List*\n\nNo one has been granted access yet.';
      } else {
        text = '📋 *Access List*\n\n' + list.map(u => {
          const exp = u.expiresAt ? new Date(u.expiresAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Permanent';
          return `👤 \`${u.userId}\` — expires: ${exp}`;
        }).join('\n');
      }
      await renderMenu(chatId, messageId, text, { inline_keyboard: [[{ text: '🌐 Admin Panel', callback_data: 'admin' }]] });

    } else if (data === 'admin_proxy') {
      await renderMenu(chatId, messageId, `🌐 *Proxy Settings*\n\n${maskedProxyText()}\n\nUsed as a fallback when a direct Instagram check fails.`, proxyPanelKeyboard());

    } else if (data === 'proxy_set') {
      pending.set(chatId, { action: 'proxy_server' });
      await renderMenu(chatId, messageId, 'Send the proxy server as `host:port`.', cancelMenuKeyboard('admin_proxy'));

    } else if (data === 'proxy_clear') {
      store.clearProxy();
      delete process.env.PROXY_SERVER;
      delete process.env.PROXY_USERNAME;
      delete process.env.PROXY_PASSWORD;
      await renderMenu(chatId, messageId, `✅ Proxy cleared.\n\n${maskedProxyText()}`, proxyPanelKeyboard());

    // ─── Grant duration picker ──────────────────────────────────────────────

    } else if (data.startsWith('dur_')) {
      const state = pending.get(chatId);
      if (!state || state.action !== 'awaiting_duration' || !state.targetUserId) {
        await bot.answerCallbackQuery(query.id, { text: 'Session expired, start again.', show_alert: true });
        await showAdminPanel(chatId, messageId);
        return;
      }
      if (data === 'dur_custom') {
        pending.set(chatId, { action: 'grant_custom_minutes', targetUserId: state.targetUserId });
        await renderMenu(chatId, messageId, 'Send the number of *minutes* access should last.', cancelMenuKeyboard('admin'));
      } else {
        const durations = { dur_1d: 24 * 60 * 60 * 1000, dur_7d: 7 * 24 * 60 * 60 * 1000, dur_30d: 30 * 24 * 60 * 60 * 1000, dur_perm: null };
        const ms = durations[data];
        const expiresAt = ms ? Date.now() + ms : null;
        store.grantAccess(state.targetUserId, expiresAt);
        pending.delete(chatId);
        const expText = expiresAt ? new Date(expiresAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Permanent';
        await renderMenu(chatId, messageId, `✅ Access granted to \`${state.targetUserId}\`\nExpires: ${expText}`, adminPanelKeyboard());
      }
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('[callback_query] error:', err.message);
  }
});

// ─── Text replies (used for whatever the pending action needs) ────────────

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = pending.get(chatId);

  const admin = store.isAdmin(userId);
  const authorized = store.isMonitoringAuthorized(userId);

  // Type "TEST" (any case) any time to trigger a one-off test notification to Discord
  if (!state && authorized && msg.text.trim().toLowerCase() === 'test') {
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    pending.set(chatId, { action: 'test_username' });
    await bot.sendMessage(chatId, '🧪 Send the *username* to send a test monitoring message for.', {
      parse_mode: 'Markdown', reply_markup: cancelMenuKeyboard()
    });
    return;
  }

  if (!state) return; // not waiting for anything from this chat

  const monitoringStates = ['add', 'status', 'webhook_url', 'test_username'];
  const adminStates = ['grant_userid', 'awaiting_duration', 'grant_custom_minutes', 'revoke_userid', 'proxy_server', 'proxy_username', 'proxy_password'];

  if (monitoringStates.includes(state.action) && !authorized) return;
  if (adminStates.includes(state.action) && !admin) return;

  if (state.action === 'add') {
    const username = msg.text.trim().replace('@', '').split(/\s+/)[0];
    const accounts = store.listAccounts();
    if (accounts.length >= MAX_ACCOUNTS) {
      await bot.sendMessage(chatId, `⚠️ Limit reached (${MAX_ACCOUNTS}).`);
      return showMainMenu(chatId, userId);
    }
    const added = store.addAccount(username, userId);
    if (!added) {
      await bot.sendMessage(chatId, `ℹ️ @${username} is already added.`);
      return showMainMenu(chatId, userId);
    }
    await bot.sendMessage(chatId, `✅ *@${username} added*`, { parse_mode: 'Markdown' });
    await showMainMenu(chatId, userId);

    const result = await checker.check(username);
    if (result) store.updateStatus(username, result.banned ? 'banned' : 'active');

  } else if (state.action === 'status') {
    const username = msg.text.trim().replace('@', '').split(/\s+/)[0];
    const waitMsg = await bot.sendMessage(chatId, `⏳ Checking @${username}...`);
    const result = await checker.check(username);
    if (!result) {
      await bot.editMessageText(`❌ Couldn't check @${username} right now — try again shortly.`, { chat_id: chatId, message_id: waitMsg.message_id });
    } else {
      store.updateStatus(username, result.banned ? 'banned' : 'active');
      const text = result.banned
        ? `🔴 @${username} is banned/unavailable.`
        : `🟢 @${username} is active — ${result.followers ?? '?'} followers, ${result.following ?? '?'} following, ${result.posts ?? '?'} posts.`;
      await bot.editMessageText(text, { chat_id: chatId, message_id: waitMsg.message_id });
    }
    await showMainMenu(chatId, userId);

  } else if (state.action === 'webhook_url') {
    const url = msg.text.trim();
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) {
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      await bot.sendMessage(chatId, '⚠️ That doesn\'t look like a Discord webhook URL. Try again or Cancel.');
      return;
    }
    store.setSetting('discordWebhookUrl', url);
    process.env.DISCORD_WEBHOOK_URL = url;
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    await bot.sendMessage(chatId, '✅ Discord webhook saved.');
    await showMainMenu(chatId, userId);

  } else if (state.action === 'test_username') {
    const username = msg.text.trim().replace('@', '').split(/\s+/)[0];
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    const waitMsg = await bot.sendMessage(chatId, `🧪 Sending test monitoring message for @${username}...`);
    const result = await checker.check(username);
    if (!result) {
      await bot.editMessageText(`❌ Couldn't fetch @${username} right now — try again shortly.`, { chat_id: chatId, message_id: waitMsg.message_id });
      return;
    }
    await discord.sendEmbed({ username, ...result, isTest: true });
    await bot.editMessageText(`✅ Test message for @${username} sent to Discord.`, { chat_id: chatId, message_id: waitMsg.message_id });
    await showMainMenu(chatId, userId);

  // ─── Admin: grant / revoke / proxy ──────────────────────────────────────

  } else if (state.action === 'grant_userid') {
    const targetUserId = msg.text.trim().replace(/[^0-9]/g, '');
    if (!targetUserId) {
      await bot.sendMessage(chatId, '⚠️ That doesn\'t look like a valid numeric user ID.');
      return;
    }
    pending.set(chatId, { action: 'awaiting_duration', targetUserId });
    await bot.sendMessage(chatId, `How long should access last for \`${targetUserId}\`?`, {
      parse_mode: 'Markdown', reply_markup: durationKeyboard()
    });

  } else if (state.action === 'grant_custom_minutes') {
    const minutes = parseInt(msg.text.trim());
    if (!minutes || minutes < 1) {
      await bot.sendMessage(chatId, '⚠️ Send a valid number of minutes.');
      return;
    }
    const expiresAt = Date.now() + minutes * 60000;
    store.grantAccess(state.targetUserId, expiresAt);
    pending.delete(chatId);
    const expText = new Date(expiresAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    await bot.sendMessage(chatId, `✅ Access granted to \`${state.targetUserId}\`\nExpires: ${expText}`, { parse_mode: 'Markdown' });
    await showAdminPanel(chatId);

  } else if (state.action === 'revoke_userid') {
    const targetUserId = msg.text.trim().replace(/[^0-9]/g, '');
    const removed = store.revokeAccess(targetUserId);
    await bot.sendMessage(chatId, removed ? `🗑️ Access revoked for \`${targetUserId}\`.` : `ℹ️ \`${targetUserId}\` didn't have access.`, { parse_mode: 'Markdown' });
    await showAdminPanel(chatId);

  } else if (state.action === 'proxy_server') {
    const server = msg.text.trim();
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    pending.set(chatId, { action: 'proxy_username', server });
    await bot.sendMessage(chatId, 'Send proxy *username* (or type `skip` if none).', { parse_mode: 'Markdown', reply_markup: cancelMenuKeyboard('admin_proxy') });

  } else if (state.action === 'proxy_username') {
    const username = msg.text.trim();
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    pending.set(chatId, { action: 'proxy_password', server: state.server, username: username.toLowerCase() === 'skip' ? null : username });
    await bot.sendMessage(chatId, 'Send proxy *password* (or type `skip` if none).', { parse_mode: 'Markdown', reply_markup: cancelMenuKeyboard('admin_proxy') });

  } else if (state.action === 'proxy_password') {
    const password = msg.text.trim();
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    const proxy = {
      server: state.server,
      username: state.username || null,
      password: password.toLowerCase() === 'skip' ? null : password
    };
    store.setProxy(proxy);
    process.env.PROXY_SERVER = proxy.server;
    if (proxy.username) process.env.PROXY_USERNAME = proxy.username;
    if (proxy.password) process.env.PROXY_PASSWORD = proxy.password;
    pending.delete(chatId);
    await bot.sendMessage(chatId, `✅ Proxy saved.\n\n${maskedProxyText()}`, { parse_mode: 'Markdown' });
    await showAdminPanel(chatId);
  }
});

// ─── Background monitoring loop ────────────────────────────────────────────

let monitorTimer = null;

async function runCheckCycle() {
  const accounts = store.listAccounts();
  for (const acc of accounts) {
    const result = await checker.check(acc.username);
    if (!result) continue;

    const newStatus = result.banned ? 'banned' : 'active';
    // Only notify when an account comes BACK (banned -> active). Bans themselves are not posted.
    if (acc.status === 'banned' && newStatus === 'active') {
      await discord.sendEmbed({ username: acc.username, ...result });
    }
    store.updateStatus(acc.username, newStatus);
    await new Promise(r => setTimeout(r, 3000));
  }
}

function restartMonitorLoop() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(runCheckCycle, checkInterval);
}

// Restore saved webhook + proxy settings (set via buttons) on boot
const savedWebhook = store.getSetting('discordWebhookUrl', null);
if (savedWebhook) process.env.DISCORD_WEBHOOK_URL = savedWebhook;

const savedProxy = store.getProxy();
if (savedProxy && savedProxy.server) {
  process.env.PROXY_SERVER = savedProxy.server;
  if (savedProxy.username) process.env.PROXY_USERNAME = savedProxy.username;
  if (savedProxy.password) process.env.PROXY_PASSWORD = savedProxy.password;
}

console.log('🤖 Telegram IG Unban Monitor starting...');
restartMonitorLoop();
console.log(`✅ Bot running. Checking every ${Math.round(checkInterval / 60000)} min. Max accounts: ${MAX_ACCOUNTS}.`);

# Telegram Instagram Unban Monitor (→ Discord alerts)

Button-driven Telegram bot. Watches Instagram accounts, and when a banned
account comes back (unban), posts an alert to a Discord channel via webhook.
Access is admin-controlled, with an Admin Panel for granting time-limited
access and managing the proxy fallback.

## Setup

1. Install dependencies:
   ```bash
   npm install
   npm run build   # downloads Chromium for Puppeteer
   ```

2. Get a Telegram bot token from [@BotFather](https://t.me/BotFather) → `/newbot`.

3. Get your own Telegram user ID from [@userinfobot](https://t.me/userinfobot).

4. Copy `.env.example` to `.env` and fill in at least:
   ```
   TELEGRAM_BOT_TOKEN=...
   ADMIN_TELEGRAM_IDS=your_telegram_id
   ```
   (Discord webhook and proxy can be set later from inside the bot.)

5. Run:
   ```bash
   npm start
   ```

6. Message your bot on Telegram, send `/start`.

## Roles

- **Admin** (`ADMIN_TELEGRAM_IDS`): sees the 🛠 Admin Panel button. Admins do
  **not** automatically see the monitoring status card/accounts — grant
  yourself access too (via Admin Panel → Grant Access) if you also want to
  monitor accounts yourself.
- **Authorized user** (granted access by an admin, with or without an
  expiry): sees the full monitoring card + Add Account / Accounts / Status /
  Settings buttons.
- **Everyone else**: gets a "no access" message and nothing else.

## Admin Panel

- **➕ Grant Access** — send a Telegram user ID, then pick a duration
  (1 Day / 7 Days / 30 Days / Permanent / custom minutes).
- **➖ Revoke Access** — send a user ID to remove their access immediately.
- **📋 List Access** — see everyone with access and when it expires.
- **🌐 Proxy Settings** — set/clear the proxy used as a fallback when a
  direct Instagram check fails (same `PROXY_SERVER` / `PROXY_USERNAME` /
  `PROXY_PASSWORD` mechanism as the original Discord bot). Credentials you
  type are deleted from the chat right after saving.

## Monitoring buttons

- **Add Account** — start watching a username.
- **Accounts** — list watched accounts with status dots.
- **Status** — check one account right now.
- **Settings** — view interval/limits, set the Discord webhook URL (also
  auto-deleted from chat after saving).
- Type **TEST** any time (while authorized) to send a one-off test embed to
  Discord for a chosen username — useful to confirm the webhook works.

## Notes

- Only **unbans** are posted to Discord (banned → active). A ban happening
  is tracked silently so the bot knows to alert once it's undone.
- `watchlist.json` stores accounts, settings, access grants, and proxy
  config — no MongoDB required.
- Puppeteer (headless Chromium) is heavy — this runs fine on a Windows/Linux
  PC or a small VPS. It will likely **not** run well inside Pydroid3 on
  Android (Pydroid3 is Python-only) — use Termux + Node.js instead for
  on-device.

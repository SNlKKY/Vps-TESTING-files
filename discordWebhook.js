// discordWebhook.js — posts ban/unban notifications to Discord via a plain
// webhook URL (Server Settings → Integrations → Webhooks → New Webhook →
// Copy URL). No bot token or bot login needed on the Discord side.

const axios = require('axios');

function formatTimeTaken(ms) {
  if (!ms && ms !== 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

async function sendEmbed({ username, banned, timeTakenMs, isTest }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[discord] DISCORD_WEBHOOK_URL not set — skipping notification');
    return;
  }

  const profileUrl = `https://www.instagram.com/${username}/`;
  const embed = {
    title: banned ? "You've been banned on Instagram" : "You're back on Instagram",
    description: `[www.instagram.com/${username}](${profileUrl})`,
    color: banned ? 0xE74C3C : 0x2ECC71,
    fields: [
      { name: '⏱️ Time Taken', value: formatTimeTaken(timeTakenMs), inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: isTest ? 'TEST' : 'Instagram Unban Monitor' }
  };

  try {
    await axios.post(webhookUrl, { embeds: [embed] });
  } catch (err) {
    console.error('[discord] webhook send failed:', err.response?.data || err.message);
  }
}

module.exports = { sendEmbed };

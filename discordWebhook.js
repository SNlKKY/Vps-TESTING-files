// discordWebhook.js — posts ban/unban notifications to Discord via a plain
// webhook URL (Server Settings → Integrations → Webhooks → New Webhook →
// Copy URL). No bot token or bot login needed on the Discord side.

const axios = require('axios');
const FormData = require('form-data');

async function sendEmbed({ username, banned, followers, following, posts, profilePic, isTest }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[discord] DISCORD_WEBHOOK_URL not set — skipping notification');
    return;
  }

  const prefix = isTest ? '🧪 TEST — ' : '';
  const embed = {
    title: banned ? `${prefix}🔴 @${username} — BANNED / REMOVED` : `${prefix}✅ @${username} — ACTIVE (Unbanned)`,
    color: isTest ? 0x5865F2 : (banned ? 0xE74C3C : 0x2ECC71),
    fields: banned ? [] : [
      { name: 'Followers', value: String(followers ?? '—'), inline: true },
      { name: 'Following', value: String(following ?? '—'), inline: true },
      { name: 'Posts', value: String(posts ?? '—'), inline: true }
    ],
    url: `https://www.instagram.com/${username}/`,
    timestamp: new Date().toISOString(),
    footer: { text: isTest ? 'Instagram Unban Monitor — test message' : 'Instagram Unban Monitor' }
  };

  try {
    if (profilePic) {
      const form = new FormData();
      embed.image = { url: 'attachment://profile.jpg' };
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('files[0]', profilePic, { filename: 'profile.jpg' });
      await axios.post(webhookUrl, form, { headers: form.getHeaders() });
    } else {
      await axios.post(webhookUrl, { embeds: [embed] });
    }
  } catch (err) {
    console.error('[discord] webhook send failed:', err.response?.data || err.message);
  }
}

module.exports = { sendEmbed };

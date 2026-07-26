// checker.js — checks whether an Instagram profile is live or banned/removed.
// Same detection approach as the original Discord bot: read og:title / og:description
// meta tags from the public profile page (no login needed).

const path = require('path');
const fs = require('fs');

function parseNum(str) {
  if (!str) return null;
  str = str.trim();
  if (/[Kk]$/.test(str)) return String(Math.round(parseFloat(str) * 1000));
  if (/[Mm]$/.test(str)) return String(Math.round(parseFloat(str) * 1000000));
  if (/[Bb]$/.test(str)) return String(Math.round(parseFloat(str) * 1000000000));
  return str.replace(/,/g, '');
}

async function checkOnceInternal(username, useProxy) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    let chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800'
    ];

    if (useProxy && process.env.PROXY_SERVER) {
      launchArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);
      launchArgs.push('--ignore-certificate-errors');
    }

    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: launchArgs
    });

    const page = await browser.newPage();

    if (useProxy && process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
      await page.authenticate({
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
      });
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const blockedTypes = ['image', 'stylesheet', 'font', 'media'];
      if (blockedTypes.includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 4000));

    const data = await page.evaluate(() => {
      const ogDesc  = document.querySelector('meta[property="og:description"]');
      const ogImg   = document.querySelector('meta[property="og:image"]');
      const ogTitle = document.querySelector('meta[property="og:title"]');
      return {
        desc:  ogDesc  ? ogDesc.getAttribute('content')  : '',
        img:   ogImg   ? ogImg.getAttribute('content')   : '',
        title: ogTitle ? ogTitle.getAttribute('content') : '',
        pageText: document.body ? document.body.innerText.substring(0, 300) : ''
      };
    });

    const raw = data.desc || '';
    const numPat  = '([\\d,.]+[KMBkmb]?)';
    const fMatch  = raw.match(new RegExp(numPat + '\\s*Followers?', 'i'));
    const foMatch = raw.match(new RegExp(numPat + '\\s*Following', 'i'));
    const pMatch  = raw.match(new RegExp(numPat + '\\s*Posts?', 'i'));

    const followers = fMatch  ? parseNum(fMatch[1])  : null;
    const following = foMatch ? parseNum(foMatch[1]) : null;
    const posts     = pMatch  ? parseNum(pMatch[1])  : null;

    let profilePic = null;
    if (data.img) {
      try {
        const b64 = await page.evaluate(async (url) => {
          return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = () => {
              if (xhr.status === 200) {
                const bytes = new Uint8Array(xhr.response);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                resolve(btoa(binary));
              } else resolve(null);
            };
            xhr.onerror = () => resolve(null);
            xhr.timeout = 8000;
            xhr.ontimeout = () => resolve(null);
            xhr.send();
          });
        }, data.img);
        if (b64) profilePic = Buffer.from(b64, 'base64');
      } catch (_) {}
    }

    await browser.close();
    browser = null;

    const combinedText = (data.title + ' ' + data.pageText + ' ' + raw).toLowerCase();
    const explicitlyUnavailable =
      /page isn't available|page not found|content isn't available|user not found|link you followed may be broken|page you're looking for doesn't exist/i.test(combinedText);

    const titleLooksGeneric =
      !data.title || (!data.title.includes('@' + username) && !/instagram photos and videos/i.test(data.title));

    if (!followers && !following) {
      if (explicitlyUnavailable || titleLooksGeneric) {
        return { banned: true, followers, following, posts, profilePic };
      }
      return null; // ambiguous — treat as error, caller will retry
    }

    return { banned: false, followers, following, posts, profilePic };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

async function checkOnce(username) {
  let result = await checkOnceInternal(username, false);
  if (result === null && process.env.PROXY_SERVER) {
    result = await checkOnceInternal(username, true);
  }
  return result;
}

async function check(username, retries = 2) {
  for (let i = 0; i < retries; i++) {
    const result = await checkOnce(username);
    if (result !== null) return result;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
  }
  return null; // couldn't determine — don't report a false ban
}

module.exports = { check, parseNum };

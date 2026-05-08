import { chromium } from 'playwright';

const MAX_BROWSERS = Number(process.env.MAX_BROWSERS || 4);
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 20 * 60 * 1000);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 45_000);
const CHALLENGE_WAIT_MS = Number(process.env.CHALLENGE_WAIT_MS || 8_000);

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let sharedBrowser = null;
let activeContexts = 0;
const waiters = [];

const cache = new Map();
const inflight = new Map();

async function getBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });
  }
  return sharedBrowser;
}

function acquireSlot() {
  if (activeContexts < MAX_BROWSERS) {
    activeContexts++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next();
  else activeContexts--;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function cookieHeaderFromArray(cookies, targetHost) {
  return cookies
    .filter((c) => !c.domain || targetHost.endsWith(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function detectChallenge(html, status) {
  if (!html || typeof html !== 'string') return null;
  const lower = html.toLowerCase();
  if (lower.includes('awswaf') || lower.includes('aws-waf-token')) return 'aws-waf';
  if (lower.includes('cf-chl') || lower.includes('challenge-platform') || lower.includes('cloudflare')) return 'cloudflare';
  if (lower.includes('captcha') && lower.includes('verify')) return 'generic-captcha';
  if (status === 403 || status === 429 || status === 503) return 'blocked';
  return null;
}

export async function solveAndGetCookies(targetUrl, { force = false } = {}) {
  const host = hostnameOf(targetUrl);
  if (!host) throw new Error('Invalid URL');

  const cached = cache.get(host);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return { ...cached.payload, cached: true };
  }

  if (inflight.has(host)) return inflight.get(host);

  const promise = (async () => {
    await acquireSlot();
    let context;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);

      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });

      // Give challenge JS a moment to run and set cookies.
      await page.waitForTimeout(CHALLENGE_WAIT_MS);

      let html = '';
      try {
        html = await page.content();
      } catch {}

      const status = response?.status() ?? 0;
      const challenge = detectChallenge(html, status);

      // If we still see a challenge page after the wait, try one more reload.
      if (challenge && challenge !== 'blocked') {
        await page.waitForTimeout(3_000);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          await page.waitForTimeout(CHALLENGE_WAIT_MS);
          html = await page.content();
        } catch {}
      }

      const cookies = await context.cookies();
      const finalChallenge = detectChallenge(html, status);

      if (finalChallenge === 'generic-captcha') {
        const err = new Error('Interactive captcha required (not supported in v1).');
        err.code = 'CAPTCHA_REQUIRED';
        err.kind = finalChallenge;
        throw err;
      }

      if (!cookies.length) {
        const err = new Error('No cookies were issued by the target site.');
        err.code = 'NO_COOKIES';
        throw err;
      }

      const payload = {
        url: targetUrl,
        host,
        userAgent: UA,
        cookies,
        cookieHeader: cookieHeaderFromArray(cookies, host),
        fetchedAt: new Date().toISOString(),
        cached: false,
      };

      cache.set(host, { payload, expiresAt: Date.now() + COOKIE_TTL_MS });
      return payload;
    } finally {
      if (context) await context.close().catch(() => {});
      releaseSlot();
      inflight.delete(host);
    }
  })();

  inflight.set(host, promise);
  return promise;
}

export async function fetchThroughBrowser(targetUrl, { method = 'GET', headers = {}, body } = {}) {
  const host = hostnameOf(targetUrl);
  if (!host) throw new Error('Invalid URL');

  await solveAndGetCookies(targetUrl);

  await acquireSlot();
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ userAgent: UA });
    const cached = cache.get(host);
    if (cached) await context.addCookies(cached.payload.cookies);

    const apiContext = context.request;
    const res = await apiContext.fetch(targetUrl, {
      method,
      headers: { 'User-Agent': UA, ...headers },
      data: body,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: res.status(),
      headers: res.headers(),
      body: json ?? text,
      isJson: json !== null,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    releaseSlot();
  }
}

export function cacheStats() {
  return {
    hosts: cache.size,
    activeContexts,
    queued: waiters.length,
    maxBrowsers: MAX_BROWSERS,
  };
}

export function purgeCache(host) {
  if (host) return cache.delete(host);
  cache.clear();
  return true;
}

export async function shutdown() {
  if (sharedBrowser) await sharedBrowser.close().catch(() => {});
  sharedBrowser = null;
}

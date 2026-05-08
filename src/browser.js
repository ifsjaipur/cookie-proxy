import { chromium } from 'rebrowser-playwright';

const MAX_BROWSERS = Number(process.env.MAX_BROWSERS || 4);
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 20 * 60 * 1000);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60_000);
const CHALLENGE_MAX_WAIT_MS = Number(process.env.CHALLENGE_MAX_WAIT_MS || 30_000);
const CHALLENGE_POLL_MS = 500;

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Patches that hide the most obvious "this is automated" tells. Injected
// before any page script runs.
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin' })),
  });
  window.chrome = window.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }
`;

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
        '--disable-features=IsolateOrigins,site-per-process',
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

// Returns the kind of challenge page we're looking at, or null if we're
// already on the real page.
function classifyPage(html, title, status) {
  if (!html || typeof html !== 'string') return null;
  const lower = html.toLowerCase();
  const lowerTitle = (title || '').toLowerCase();

  if (
    lowerTitle.includes('human verification') ||
    lower.includes('captcha-container') ||
    lower.includes('awsintegration') ||
    lower.includes('aws-waf') ||
    lower.includes('awswaf')
  ) {
    return 'aws-waf';
  }
  if (
    lower.includes('cf-chl') ||
    lower.includes('challenge-platform') ||
    lowerTitle.includes('just a moment') ||
    lowerTitle.includes('attention required')
  ) {
    return 'cloudflare';
  }
  if (status === 403 || status === 429 || status === 503) return 'blocked';
  return null;
}

// Wait until the challenge page gives way to the real content. AWS WAF and
// Cloudflare both reload the page after their JS challenge succeeds, so we
// poll the document until the challenge markers disappear (or we time out).
async function waitForChallengeToClear(page) {
  const deadline = Date.now() + CHALLENGE_MAX_WAIT_MS;
  let lastKind = null;
  while (Date.now() < deadline) {
    let html = '';
    let title = '';
    try {
      html = await page.content();
      title = await page.title();
    } catch {
      // page may be navigating; just retry
      await new Promise((r) => setTimeout(r, CHALLENGE_POLL_MS));
      continue;
    }
    const kind = classifyPage(html, title, 200);
    if (!kind) return { cleared: true, kind: lastKind };
    lastKind = kind;
    await new Promise((r) => setTimeout(r, CHALLENGE_POLL_MS));
  }
  return { cleared: false, kind: lastKind };
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
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      await context.addInitScript(STEALTH_INIT);

      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);

      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;

      const result = await waitForChallengeToClear(page);

      // Give the page a moment to set any final cookies after the challenge
      // clears (some sites set session cookies on the post-challenge load).
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {}

      const cookies = await context.cookies();
      let html = '';
      let title = '';
      try {
        html = await page.content();
        title = await page.title();
      } catch {}
      const finalKind = classifyPage(html, title, status);

      if (!result.cleared && finalKind) {
        const err = new Error(
          `Challenge did not clear within ${CHALLENGE_MAX_WAIT_MS}ms (kind=${finalKind}). ` +
            'Site may require interactive captcha or stronger fingerprint masking.'
        );
        err.code = finalKind === 'aws-waf' || finalKind === 'cloudflare' ? 'CHALLENGE_TIMEOUT' : 'CAPTCHA_REQUIRED';
        err.kind = finalKind;
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
        challengeKindSeen: result.kind,
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

// Like solveAndGetCookies but never throws and returns rich diagnostics.
// For figuring out WHY a challenge isn't clearing (IP block? JS load
// failure? fingerprint flag?).
export async function debugSolve(targetUrl, { waitMs = 30_000 } = {}) {
  const host = hostnameOf(targetUrl);
  if (!host) throw new Error('Invalid URL');

  await acquireSlot();
  let context;
  const consoleMessages = [];
  const wafResponses = [];
  const navigations = [];
  let actualUA = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await context.addInitScript(STEALTH_INIT);

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    page.on('console', (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 300) });
    });
    page.on('pageerror', (err) => {
      consoleMessages.push({ type: 'pageerror', text: String(err).slice(0, 300) });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    page.on('response', (res) => {
      const u = res.url();
      if (u.includes('awswaf') || u.includes('captcha') || u.includes('challenge')) {
        wafResponses.push({ url: u, status: res.status() });
      }
    });

    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    const initialStatus = response?.status() ?? 0;
    const initialHeaders = response?.headers() ?? {};

    try {
      actualUA = await page.evaluate(() => navigator.userAgent);
    } catch {}

    // Just wait — no early exit — so we capture everything that happens.
    await new Promise((r) => setTimeout(r, waitMs));

    let finalHtml = '';
    let finalTitle = '';
    try {
      finalHtml = await page.content();
      finalTitle = await page.title();
    } catch {}

    const cookies = await context.cookies();
    const fingerprint = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      languages: navigator.languages,
      pluginCount: navigator.plugins?.length ?? null,
      hasChrome: typeof window.chrome !== 'undefined',
      vendor: navigator.vendor,
      platform: navigator.platform,
      hwConcurrency: navigator.hardwareConcurrency,
      maxTouchPoints: navigator.maxTouchPoints,
    })).catch(() => null);

    return {
      url: targetUrl,
      host,
      configuredUA: UA,
      actualUA,
      initialStatus,
      initialHeaders,
      navigations,
      wafResponses,
      consoleMessages,
      finalTitle,
      finalHtmlPreview: finalHtml.slice(0, 1500),
      finalHtmlLength: finalHtml.length,
      stillOnChallenge: classifyPage(finalHtml, finalTitle, initialStatus) !== null,
      cookies,
      cookieCount: cookies.length,
      fingerprint,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    releaseSlot();
  }
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
    await context.addInitScript(STEALTH_INIT);
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

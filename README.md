# cookie-proxy

A small browser-backed service that returns cookies and tokens from sites
protected by Cloudflare, AWS WAF, and similar bot-protection layers — so an
n8n HTTP Request node (or any plain HTTP client) can call those APIs without
getting a CAPTCHA / "Human Verification" page back.

It runs Playwright + headless Chromium internally, lets the challenge JS run,
extracts the resulting cookies, and hands them back as JSON. Cookies are
cached per-host so we don't launch a browser on every request.

## Endpoints

All endpoints (except `/health` and `/`) require:

```
Authorization: Bearer cp_xxxxxxxxxxxxxxxx
```

| Method | Path        | Purpose                                                  |
| ------ | ----------- | -------------------------------------------------------- |
| POST   | `/cookies`  | Solve the challenge for a URL and return cookies.        |
| POST   | `/fetch`    | Fully proxy the request via the browser context.         |
| POST   | `/purge`    | Clear cached cookies for a host (or all if no host).     |
| GET    | `/stats`    | Pool / cache state.                                      |
| GET    | `/health`   | Liveness probe (no auth).                                |

### POST /cookies

Request:

```json
{ "url": "https://trendlyne.com/equity/12345/", "force": false }
```

Response:

```json
{
  "url": "https://trendlyne.com/equity/12345/",
  "host": "trendlyne.com",
  "userAgent": "Mozilla/5.0 ...",
  "cookies": [
    { "name": "aws-waf-token", "value": "...", "domain": ".trendlyne.com", ... }
  ],
  "cookieHeader": "aws-waf-token=...; sessionid=...",
  "fetchedAt": "2026-05-08T07:21:33.000Z",
  "cached": false
}
```

Use `cookieHeader` directly in the `Cookie` header of your real API call.

### POST /fetch

Request:

```json
{
  "url": "https://trendlyne.com/some/api?x=1",
  "method": "GET",
  "headers": { "Accept": "application/json" }
}
```

Response is the upstream response (status, headers, body). JSON bodies are
parsed; everything else is returned as text.

## Deploying on Coolify (proxy.ifsjaipur.cloud)

1. Push this folder to a Git repo (GitHub / Gitea / your Coolify-connected source).
2. In Coolify, **New Resource → Application → Public/Private Repository**.
3. Build pack: **Dockerfile**. Coolify will detect the `Dockerfile` in the repo root.
4. **Domain:** `https://proxy.ifsjaipur.cloud` — Coolify provisions a Let's
   Encrypt cert automatically once DNS is pointed at the VPS.
5. **Persistent storage:** add a volume mount `/data` → `cookie-proxy-data`.
   This is where the SQLite key file lives; without it your keys evaporate on
   redeploy.
6. **Environment variables** — copy from `.env.example`. The defaults are sane;
   tune `MAX_BROWSERS` to match your VPS RAM (~300MB per active browser).
7. **Port:** 3000 (Coolify maps this to 443 via its reverse proxy).
8. Deploy.

### Issuing API keys

Coolify lets you exec into the running container:

```bash
node bin/issue-key.js sachin            # default 60 req/min
node bin/issue-key.js friend-aman 30    # custom rate
node bin/list-keys.js                   # see all keys
node bin/revoke-key.js cp_AbCdEf1234    # revoke by prefix or id
```

Hand the printed key to the user as their `Authorization: Bearer …` token.
The full key is **not stored** — only its SHA-256 hash — so it cannot be
recovered later. Re-issue if lost.

## Using from n8n

Two HTTP Request nodes:

**Node 1 — Get cookies**

- Method: `POST`
- URL: `https://proxy.ifsjaipur.cloud/cookies`
- Authentication: Generic Credential → Header Auth → `Authorization: Bearer cp_…`
- Body (JSON):
  ```json
  { "url": "https://trendlyne.com/equity/12345/" }
  ```

**Node 2 — Real API call**

- Method: whatever the target API needs.
- URL: the Trendlyne / target API URL.
- Headers:
  - `Cookie`: `={{ $json.cookieHeader }}`  (from Node 1)
  - `User-Agent`: `={{ $json.userAgent }}` (from Node 1)
  - whatever else the target needs (Accept, X-Requested-With, etc.)

That's it. The cookie cache means subsequent runs within ~20 minutes skip the
browser launch entirely, so the round-trip drops from ~10s to ~50ms.

### When to use `/fetch` instead

Use `/fetch` when:
- the target endpoint requires the request to come from the same browser fingerprint that solved the challenge, not just the cookie
- you don't want to manage two HTTP nodes in n8n

Trade-off: `/fetch` is ~10× heavier on the proxy than `/cookies`. Prefer
`/cookies` when it works.

## Limits and known unknowns

- **Interactive captchas (image puzzles, hCaptcha, reCAPTCHA v2 checkbox):**
  not supported in v1. The service returns `422 CAPTCHA_REQUIRED`. Most AWS WAF
  and Cloudflare deployments **don't** show interactive captchas — they use
  invisible JS challenges that this service handles.
- **Stealth:** uses stock Playwright Chromium. Some advanced WAFs (PerimeterX,
  Datadome, Kasada) may still detect it. If we hit one, we can swap to
  `rebrowser-playwright` or `puppeteer-extra-plugin-stealth` later.
- **One Chromium, many contexts:** we share a single browser process and use
  per-request browser contexts. Memory is bounded by `MAX_BROWSERS`.

## Local dev

```bash
npm install                # downloads Chromium
node bin/issue-key.js dev  # gives you a key
npm run dev                # starts on :3000
```

Smoke test:

```bash
curl -s -X POST http://127.0.0.1:3000/cookies \
  -H "Authorization: Bearer cp_..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://trendlyne.com/"}' | jq
```

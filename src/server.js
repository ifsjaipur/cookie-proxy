import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { authenticate } from './db.js';
import {
  solveAndGetCookies,
  fetchThroughBrowser,
  debugSolve,
  cacheStats,
  purgeCache,
  shutdown,
} from './browser.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

await app.register(rateLimit, {
  global: false,
  keyGenerator: (req) => req.apiKey?.id?.toString() || req.ip,
});

app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/health' || req.url === '/') return;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const key = authenticate(token);
  if (!key) {
    reply.code(401).send({ error: 'unauthorized', message: 'Provide a valid Bearer token.' });
    return reply;
  }
  req.apiKey = key;
});

app.get('/', async () => ({
  service: 'cookie-proxy',
  version: '0.1.0',
  endpoints: ['/health', 'POST /cookies', 'POST /fetch', 'POST /purge', 'GET /stats'],
}));

app.get('/health', async () => ({ ok: true, ...cacheStats() }));

app.get('/stats', {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  handler: async (req) => ({ key: req.apiKey.label, ...cacheStats() }),
});

app.post('/cookies', {
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 8 },
        force: { type: 'boolean' },
      },
    },
  },
  handler: async (req, reply) => {
    try {
      const { url, force = false } = req.body;
      const result = await solveAndGetCookies(url, { force });
      return result;
    } catch (err) {
      req.log.error({ err }, 'cookies failed');
      const code = err.code === 'CAPTCHA_REQUIRED' ? 422 : 502;
      return reply.code(code).send({
        error: err.code || 'UPSTREAM_FAILURE',
        message: err.message,
      });
    }
  },
});

app.post('/fetch', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 8 },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: {},
      },
    },
  },
  handler: async (req, reply) => {
    try {
      const { url, method, headers, body } = req.body;
      const result = await fetchThroughBrowser(url, { method, headers, body });
      return result;
    } catch (err) {
      req.log.error({ err }, 'fetch failed');
      const code = err.code === 'CAPTCHA_REQUIRED' ? 422 : 502;
      return reply.code(code).send({
        error: err.code || 'UPSTREAM_FAILURE',
        message: err.message,
      });
    }
  },
});

app.post('/debug', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 8 },
        waitMs: { type: 'integer', minimum: 1000, maximum: 60_000 },
      },
    },
  },
  handler: async (req, reply) => {
    try {
      const { url, waitMs = 30_000 } = req.body;
      const result = await debugSolve(url, { waitMs });
      return result;
    } catch (err) {
      req.log.error({ err }, 'debug failed');
      return reply.code(502).send({ error: 'DEBUG_FAILURE', message: err.message });
    }
  },
});

app.post('/purge', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  schema: {
    body: {
      type: 'object',
      properties: { host: { type: 'string' } },
    },
  },
  handler: async (req) => {
    purgeCache(req.body?.host);
    return { ok: true };
  },
});

const close = async () => {
  app.log.info('shutting down');
  await app.close();
  await shutdown();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`cookie-proxy listening on ${HOST}:${PORT}`);
});

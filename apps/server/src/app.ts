/** Fastify application: security plugins, auth, all module routes, static web (prod) with SPA fallback. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest, type RawServerDefault } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { authPlugin } from './auth/plugin';
import { publicRoute } from './auth/rbac';
import { authRoutes } from './auth/routes';
import type { AppContext } from './context';
import { notFoundBody, registerErrorHandling } from './lib/errors';

/** Default location of the built web app (apps/web/dist), relative to src/ or dist/. */
function defaultWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../web/dist');
}

/** Rate-limit bucket: the real (not «view as») user of the session, else the client IP (see TRUST_PROXY). */
export function rateLimitKey(request: Pick<FastifyRequest, 'auth' | 'ip'>): string {
  const userId = request.auth?.user.id;
  return userId ? `user:${userId}` : `ip:${request.ip}`;
}

export type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger, ZodTypeProvider>;

export async function buildApp(ctx: AppContext): Promise<App> {
  const { config } = ctx;
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.decorate('ctx', ctx);
  app.decorate('config', config);
  app.decorate('db', ctx.db);
  app.decorate('adapters', ctx.adapters);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // JSON only – no text/plain «simple requests».
  app.removeContentTypeParser('text/plain');

  registerErrorHandling(app);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });
  // Rate limits run after the session is loaded (auth plugin, onRequest) so signed-in requests are counted per user –
  // a rotating X-Forwarded-For does not give a fresh bucket. Anonymous requests (login, static) per client IP.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: rateLimitKey });
  await app.register(authPlugin);

  app.get('/api/health', { config: publicRoute() }, async (_request, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return { status: 'ok' };
    } catch {
      reply.status(503);
      return { status: 'error' };
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  for (const module of ctx.modules) {
    await app.register(module.routes, { prefix: `/api/${module.prefix ?? module.name}` });
  }

  // Built web app (production): static files + SPA fallback for client routes.
  const webDist = config.webDistDir ? path.resolve(config.webDistDir) : defaultWebDist();
  const serveWeb = existsSync(path.join(webDist, 'index.html'));
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      index: false,
      setHeaders(reply, filePath) {
        reply.header('cache-control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api');
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (serveWeb && !isApi && (request.method === 'GET' || request.method === 'HEAD') && wantsHtml) {
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.status(404).send(notFoundBody(request.id));
  });

  return app;
}

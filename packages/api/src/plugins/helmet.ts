import helmet from '@fastify/helmet';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

// Minimal security headers for a JSON-only API. We intentionally skip
// the directives that only apply to HTML-serving origins (CSP, COEP)
// because this service never returns HTML — its consumers are the
// officine web app (served from a different origin — CloudFront/S3)
// and the mobile app. The headers we keep are the universally-relevant
// transport and sniffing defenses.
//
// Layered ahead of error-handler + routes in buildServer so that even
// Problem Details error responses get the security headers.
const plugin: FastifyPluginAsync = async (app) => {
  await app.register(helmet, {
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    noSniff: true,
    frameguard: { action: 'deny' },
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
};

export default fp(plugin, {
  name: 'helmet-config',
  fastify: '5.x',
});

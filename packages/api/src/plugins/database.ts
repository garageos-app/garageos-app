import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import {
  prisma as defaultPrisma,
  withContext as defaultWithContext,
  type PrismaClient,
} from '@garageos/database';

// Signature of the withContext helper exported by @garageos/database.
// Re-declared here so the plugin file does not depend on the internal
// ctx shape of the helper (a broader change there would not ripple
// into this module).
type WithContext = <T>(
  ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
  fn: (tx: PrismaClient) => Promise<T>,
) => Promise<T>;

export interface DatabasePluginOptions {
  // Overrides used by unit tests to inject fakes. Production / integration
  // callers register the plugin with no options and get the default
  // singleton from @garageos/database (Lambda-aware; cached across warm
  // invocations — see packages/database/src/client.ts).
  prisma?: PrismaClient;
  withContext?: WithContext;
}

const plugin: FastifyPluginAsync<DatabasePluginOptions> = async (app, opts) => {
  const prisma = opts.prisma ?? defaultPrisma;
  const withContext = opts.withContext ?? defaultWithContext;

  app.decorate('prisma', prisma);
  app.decorate('withContext', withContext);

  app.addHook('onClose', async (instance) => {
    // In the vitest integration harness the Prisma client is cached on
    // globalThis across test files (packages/database/tests/integration/setup.ts:85-88);
    // disconnecting between files leaves subsequent files with a broken
    // client. `buildTestServer().close()` still fires this hook, so skip
    // $disconnect under NODE_ENV=test. The real Lambda process runs with
    // NODE_ENV=production and disconnects cleanly on SIGTERM.
    if (process.env.NODE_ENV === 'test') return;
    try {
      await prisma.$disconnect();
    } catch (err) {
      instance.log.warn({ err }, 'prisma $disconnect failed');
    }
  });
};

// fastify-plugin unwraps Fastify's default encapsulation so the decorators
// declared above are visible from routes registered on the outer
// FastifyInstance. Without fp() they would be scoped to this plugin's
// child context only and `request.server.prisma` would be undefined in
// route handlers — see https://fastify.dev/docs/latest/Reference/Plugins/.
export default fp(plugin, {
  name: 'database',
  fastify: '5.x',
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    withContext: WithContext;
  }
}

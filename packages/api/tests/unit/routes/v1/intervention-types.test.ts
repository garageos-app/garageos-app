import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import interventionTypesRoutes from '../../../../src/routes/v1/intervention-types.js';

describe('intervention-types route plugin', () => {
  it('registers GET /v1/intervention-types', async () => {
    const app = Fastify();
    await app.register(interventionTypesRoutes);
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/v1/intervention-types');
    await app.close();
  });
});

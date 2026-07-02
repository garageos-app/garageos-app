import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import rateLimitPlugin from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';

import { ALLOWED_ORIGINS } from './config/constants.js';
import { env } from './config/env.js';
import authPlugin, { type AuthPluginOptions } from './plugins/auth.js';
import databasePlugin, { type DatabasePluginOptions } from './plugins/database.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import helmetPlugin from './plugins/helmet.js';
import healthRoutes from './routes/health.js';
import deadlinesCompleteRoutes from './routes/v1/deadlines-complete.js';
import deadlinesCreateRoutes from './routes/v1/deadlines-create.js';
import deadlinesDeleteRoutes from './routes/v1/deadlines-delete.js';
import deadlinesListCustomerRoutes from './routes/v1/deadlines-list-customer.js';
import deadlinesListTenantRoutes from './routes/v1/deadlines-list-tenant.js';
import deadlinesListVehicleRoutes from './routes/v1/deadlines-list-vehicle.js';
import deadlinesUpdateRoutes from './routes/v1/deadlines-update.js';
import interventionCancelRoutes from './routes/v1/interventions-cancel.js';
import interventionDetailRoutes from './routes/v1/interventions-detail.js';
import interventionPdfRoutes from './routes/v1/interventions-pdf.js';
import interventionDisputeRoutes from './routes/v1/interventions-dispute.js';
import interventionDisputeResponseRoutes from './routes/v1/interventions-dispute-response.js';
import interventionDisputesListRoutes from './routes/v1/interventions-disputes-list.js';
import interventionRevisionsListRoutes from './routes/v1/interventions-revisions-list.js';
import { authSignupRoutes } from './routes/v1/auth-signup.js';
import { authPasswordAuditRoutes } from './routes/v1/auth-password-audit.js';
import { authVerifyEmailRoutes } from './routes/v1/auth-verify-email.js';
import { authResendVerificationRoutes } from './routes/v1/auth-resend-verification.js';
import interventionUpdateRoutes from './routes/v1/interventions-update.js';
import interventionRoutes from './routes/v1/interventions.js';
import interventionRecentRoutes from './routes/v1/interventions-recent.js';
import disputesOpenRoutes from './routes/v1/disputes-open.js';
import interventionTypesRoutes from './routes/v1/intervention-types.js';
import meVehicleRoutes from './routes/v1/me-vehicles.js';
import meVehiclesPendingRoutes from './routes/v1/me-vehicles-pending.js';
import meVehicleExportPdfRoutes from './routes/v1/me-vehicles-export-pdf.js';
import meTransfersRoutes from './routes/v1/me-transfers.js';
import mePersonalDeadlinesRoutes from './routes/v1/me-personal-deadlines.js';
import meInterventionsRoutes from './routes/v1/me-interventions.js';
import mePrivateInterventionRoutes from './routes/v1/me-private-interventions.js';
import meProfileRoutes from './routes/v1/me-profile.js';
import meNotificationPreferencesRoutes from './routes/v1/me-notification-preferences.js';
import mePushTokensRoutes from './routes/v1/me-push-tokens.js';
import userRoutes from './routes/v1/users.js';
import userUpdateRoutes from './routes/v1/users-update.js';
import { usersListRoutes } from './routes/v1/users-list.js';
import { usersInvitationsCreateRoutes } from './routes/v1/users-invitations-create.js';
import { usersInvitationsListRoutes } from './routes/v1/users-invitations-list.js';
import { usersInvitationsRevokeRoutes } from './routes/v1/users-invitations-revoke.js';
import { invitationsPublicReadRoutes } from './routes/v1/invitations-public-read.js';
import { invitationsPublicAcceptRoutes } from './routes/v1/invitations-public-accept.js';
import { usersAdminUpdateRoutes } from './routes/v1/users-admin-update.js';
import { usersAdminDeleteRoutes } from './routes/v1/users-admin-delete.js';
import { usersAdminReactivateRoutes } from './routes/v1/users-admin-reactivate.js';
import { adminMeRoutes } from './routes/v1/admin-me.js';
import { adminMetricsRoutes } from './routes/v1/admin-metrics.js';
import { adminTenantsCreateRoutes } from './routes/v1/admin-tenants-create.js';
import { adminTenantsListRoutes } from './routes/v1/admin-tenants-list.js';
import { adminTenantsLifecycleRoutes } from './routes/v1/admin-tenants-lifecycle.js';
import { adminTenantsRegenerateInvitationRoutes } from './routes/v1/admin-tenants-regenerate-invitation.js';
import { adminTenantDetailRoutes } from './routes/v1/admin-tenant-detail.js';
import { adminTenantMetricsRoutes } from './routes/v1/admin-tenant-metrics.js';
import { adminAuditLogsRoutes } from './routes/v1/admin-audit-logs.js';
import { adminTenantUsersRoutes } from './routes/v1/admin-tenant-users.js';
import { adminTenantUsersInvitationsRoutes } from './routes/v1/admin-tenant-users-invitations.js';
import { adminInterventionTypesRoutes } from './routes/v1/admin-intervention-types.js';
import customerCreateRoutes from './routes/v1/customers-create.js';
import customerDetailRoutes from './routes/v1/customers-detail.js';
import customerListRoutes from './routes/v1/customers-list.js';
import customerUpdateRoutes from './routes/v1/customers-update.js';
import customerRoutes from './routes/v1/customers.js';
import tenantRoutes from './routes/v1/tenants.js';
import tenantUpdateRoutes from './routes/v1/tenants-update.js';
import { vehiclesOwnershipTransferRoutes } from './routes/v1/vehicles-ownership-transfer.js';
import vehicleCertifyRoutes from './routes/v1/vehicles-certify.js';
import vehicleTimelineRoutes from './routes/v1/vehicles-timeline.js';
import vehicleUpdateRoutes from './routes/v1/vehicles-update.js';
import vehicleRoutes from './routes/v1/vehicles.js';
import vehicleTagRoutes from './routes/v1/vehicles-tag.js';
import vehicleTagReprintRoutes from './routes/v1/vehicles-tag-reprint.js';

export interface BuildServerOptions {
  // Database plugin overrides. Integration tests pass nothing and get
  // the @garageos/database singleton (real Postgres via PrismaPg);
  // unit tests pass a fake Prisma client so no TCP socket opens.
  database?: DatabasePluginOptions;
  // Auth plugin overrides. Integration tests point the verifier at the
  // local JWKS mock (via COGNITO_*_JWKS_URL_OVERRIDE env) and leave
  // this empty; unit tests with direct app.inject can pass in-memory
  // JWKs here to bypass HTTP entirely. See src/plugins/auth.ts.
  auth?: AuthPluginOptions;
}

// Pino transport config: pretty output in development, plain JSON in
// production (consumed by CloudWatch / log aggregators).
function buildLoggerOptions() {
  if (env.NODE_ENV === 'development') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: env.LOG_LEVEL };
}

// Factory used both by the entry point and by unit tests via
// `app.inject()`. Keep it pure: no side effects beyond instantiating
// Fastify.
//
// Plugin registration order matters:
//   1. helmet   — security headers must wrap every response including
//                  errors, so it goes FIRST (its onSend hook covers
//                  Problem Details responses too).
//   2. cors     — CORS handlers must run before rate-limit so preflight
//                  OPTIONS requests aren't accidentally throttled, and
//                  before routes so disallowed origins never reach the
//                  business logic.
//   3. rate-limit — global: false; routes opt in via config.rateLimit.
//   4. sensible — HTTP error helpers used by the error handler.
//   5. error    — error handler installed before any route.
//   6. database — decorates prisma + withContext; routes depend on it.
//   7. auth     — decorates jwtVerifier; routes + middleware depend on it.
//   8. routes   — operational (/health) at root, business under /v1.
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(),
    // trust X-Forwarded-* headers from API Gateway / ALB.
    trustProxy: true,
    disableRequestLogging: false,
    // APPENDICE_A §1.3: X-Request-ID is auto-generated when the client
    // does not supply one, and propagates to logs as `request_id`.
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'request_id',
    genReqId: () => randomUUID(),
  });

  await app.register(helmetPlugin);
  // CORS: allow the production officine web origins; in dev, also accept
  // Vite's localhost:5173. credentials: false because we use Authorization
  // header (Bearer) rather than cookies — see PR demo-1 spec §CORS.
  await app.register(cors, {
    origin:
      env.NODE_ENV === 'development'
        ? [...ALLOWED_ORIGINS, 'http://localhost:5173']
        : [...ALLOWED_ORIGINS],
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
  });
  // Rate-limiting plugin registered with global: false — routes opt in via
  // config.rateLimit. In the Lambda runtime, @fastify/aws-lambda populates
  // request.ip from x-forwarded-for[0], so no keyGenerator override is needed.
  await app.register(rateLimitPlugin, { global: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, options.database ?? {});
  await app.register(authPlugin, options.auth ?? {});
  await app.register(healthRoutes);
  await app.register(userRoutes);
  await app.register(userUpdateRoutes);
  await app.register(usersListRoutes);
  await app.register(usersInvitationsCreateRoutes);
  await app.register(usersInvitationsListRoutes);
  await app.register(usersInvitationsRevokeRoutes);
  await app.register(invitationsPublicReadRoutes);
  await app.register(invitationsPublicAcceptRoutes);
  await app.register(usersAdminUpdateRoutes);
  await app.register(usersAdminDeleteRoutes);
  await app.register(usersAdminReactivateRoutes);
  await app.register(adminMeRoutes);
  await app.register(adminMetricsRoutes);
  await app.register(adminTenantsCreateRoutes);
  await app.register(adminTenantsListRoutes);
  await app.register(adminTenantsLifecycleRoutes);
  await app.register(adminTenantsRegenerateInvitationRoutes);
  await app.register(adminTenantDetailRoutes);
  await app.register(adminTenantMetricsRoutes);
  await app.register(adminAuditLogsRoutes);
  await app.register(adminTenantUsersRoutes);
  await app.register(adminTenantUsersInvitationsRoutes);
  await app.register(adminInterventionTypesRoutes);
  await app.register(tenantRoutes);
  await app.register(tenantUpdateRoutes);
  await app.register(customerRoutes);
  await app.register(customerListRoutes);
  await app.register(customerCreateRoutes);
  await app.register(customerDetailRoutes);
  await app.register(customerUpdateRoutes);
  await app.register(vehicleRoutes);
  await app.register(vehicleUpdateRoutes);
  await app.register(vehicleCertifyRoutes);
  await app.register(vehiclesOwnershipTransferRoutes);
  await app.register(vehicleTagRoutes);
  await app.register(vehicleTagReprintRoutes);
  await app.register(vehicleTimelineRoutes);
  await app.register(interventionRoutes);
  await app.register(interventionDetailRoutes);
  await app.register(interventionPdfRoutes);
  await app.register(interventionRecentRoutes);
  await app.register(disputesOpenRoutes);
  await app.register(interventionTypesRoutes);
  await app.register(interventionUpdateRoutes);
  await app.register(interventionRevisionsListRoutes);
  await app.register(interventionDisputeRoutes);
  await app.register(interventionDisputeResponseRoutes);
  await app.register(interventionDisputesListRoutes);
  await app.register(authSignupRoutes);
  await app.register(authPasswordAuditRoutes);
  await app.register(authVerifyEmailRoutes);
  await app.register(authResendVerificationRoutes);
  await app.register(interventionCancelRoutes);
  await app.register(deadlinesCreateRoutes);
  await app.register(deadlinesListVehicleRoutes);
  await app.register(deadlinesUpdateRoutes);
  await app.register(deadlinesDeleteRoutes);
  await app.register(deadlinesCompleteRoutes);
  await app.register(deadlinesListCustomerRoutes);
  await app.register(deadlinesListTenantRoutes);
  await app.register(meVehicleRoutes);
  await app.register(meVehiclesPendingRoutes);
  await app.register(meVehicleExportPdfRoutes);
  await app.register(meTransfersRoutes);
  await app.register(mePersonalDeadlinesRoutes);
  await app.register(meInterventionsRoutes);
  await app.register(mePrivateInterventionRoutes);
  await app.register(meProfileRoutes);
  await app.register(meNotificationPreferencesRoutes);
  await app.register(mePushTokensRoutes);

  // Echo the request id back so clients can correlate. Fastify sets
  // this by default for 2xx responses; doing it via onSend covers
  // errors too (the error handler preserves the header since it only
  // touches body/status/content-type).
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  return app;
}

// Intervention status discriminated union shared across the web app.
// Mirrors the backend `intervention_status` Postgres enum and the
// Prisma `Intervention.status` literal. Kept as a web-local literal
// union (not re-exported from `@garageos/database`) to avoid pulling
// `@prisma/client` into the Vite bundle.
//
// When the backend adds a new status value, update both:
//   - Prisma schema enum `intervention_status` in
//     `packages/database/prisma/schema.prisma`
//   - This union (and ensure all consuming components handle the new
//     variant — TypeScript will flag exhaustiveness gaps).

export type InterventionStatus = 'active' | 'disputed' | 'cancelled';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditLogs } from '@/pages/AuditLogs';
import type { AuditLogItem } from '@/lib/audit-types';
import type { TenantAdminListItem } from '@/lib/tenant-types';

// Hoist shared mocks so they are available inside vi.mock factory closures.
// ApiError is re-implemented here to preserve instanceof checks inside the component.
const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
  ApiError: class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
    state: { status: 'authenticated', user: { email: 'admin@garageos.it' } },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

// Each test gets a fresh QueryClient to prevent cross-test cache bleed.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT: TenantAdminListItem = {
  id: 'tenant-001',
  businessName: 'Officina Bianchi SRL',
  vatNumber: '12345678901',
  email: 'info@bianchi.it',
  status: 'active',
  createdAt: '2026-01-15T10:00:00.000Z',
  owner: { email: 'mario@bianchi.it', invitationStatus: 'accepted' },
};

// Tenant event — tenant with a known businessName.
const AUDIT_ROW_TENANT: AuditLogItem = {
  id: 'log-001',
  createdAt: '2026-06-30T10:00:00.000Z',
  tenant: { id: 'tenant-001', businessName: 'Officina Bianchi SRL' },
  actorType: 'user',
  actorId: 'user-abc',
  action: 'create',
  entityType: 'intervention',
  entityId: 'int-001',
  ipAddress: '192.168.1.1',
  metadata: { key: 'test-value', reason: 'initial' },
};

// Platform event — tenant is null.
const AUDIT_ROW_PLATFORM: AuditLogItem = {
  id: 'log-002',
  createdAt: '2026-06-30T09:00:00.000Z',
  tenant: null,
  actorType: 'admin',
  actorId: null,
  action: 'tenant_created',
  entityType: 'tenant',
  entityId: 'tenant-001',
  ipAddress: null,
  metadata: null,
};

// Shared mock router: audit-logs and tenants respond with happy-path data.
function routeHappyPath() {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/v1/admin/tenants') {
      return Promise.resolve({ tenants: [TENANT] });
    }
    if (path.startsWith('/v1/admin/audit-logs')) {
      return Promise.resolve({
        items: [AUDIT_ROW_TENANT, AUDIT_ROW_PLATFORM],
        nextCursor: null,
      });
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('AuditLogs page', () => {
  // ── Test 1: Happy path ─────────────────────────────────────────────────────
  // Verifies both the tenant row (shows businessName) and the platform row
  // (shows "Eventi piattaforma") are rendered correctly.

  it('happy path: renders tenant row with businessName and platform row with "Eventi piattaforma"', async () => {
    routeHappyPath();

    render(<AuditLogs />, { wrapper: makeWrapper() });

    // Wait for the audit log table to populate.
    // 'Officina Bianchi SRL' appears both in the dropdown option and in the table
    // cell — findAllByText asserts it rendered in at least 2 places.
    const tenantLabels = await screen.findAllByText('Officina Bianchi SRL');
    expect(tenantLabels.length).toBeGreaterThanOrEqual(2);

    // 'Eventi piattaforma' appears both in the dropdown option and in the table
    // cell for the platform row — getAllByText asserts both occurrences.
    const platformLabels = screen.getAllByText('Eventi piattaforma');
    expect(platformLabels.length).toBeGreaterThanOrEqual(2);
  });

  // ── Test 2: Error state ────────────────────────────────────────────────────
  // Verifies the red alert renders when the audit-log fetch fails.

  it('error state: red alert renders when audit-logs fetch rejects', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/admin/tenants') {
        return Promise.resolve({ tenants: [] });
      }
      // Any audit-logs path → reject.
      return Promise.reject(new Error('Internal server error'));
    });

    render(<AuditLogs />, { wrapper: makeWrapper() });

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Errore nel caricamento del registro.');
  });

  // ── Test 3: Detail dialog ──────────────────────────────────────────────────
  // Verifies that clicking a row opens the detail dialog showing the IP address
  // and the serialized metadata JSON.

  it('detail dialog: clicking a row shows IP address and metadata JSON', async () => {
    routeHappyPath();

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<AuditLogs />, { wrapper: makeWrapper() });

    // Wait for the table to render. The Entità column shows entityType ('intervention')
    // which is not present in any dropdown option — uniquely identifies the tenant row.
    const entityTypeCell = await screen.findByText('intervention');

    // Click the row containing this cell.
    const row = entityTypeCell.closest('tr');
    expect(row).not.toBeNull();
    await user.click(row!);

    // Dialog must open.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // IP address appears in the dialog (scoped to avoid false positives).
    expect(within(dialog).getByText(/192\.168\.1\.1/)).toBeInTheDocument();

    // Dialog shows entityType / entityId — 'int-001' is only visible inside the dialog.
    expect(within(dialog).getByText(/int-001/)).toBeInTheDocument();

    // Metadata JSON rendered as <pre> — assert on the known key value.
    expect(within(dialog).getByText(/test-value/)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseFormReturn } from 'react-hook-form';

import { Settings } from './Settings';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});
import * as authModule from '@/auth/useAuth';
import * as profileMeModule from '@/queries/profileMe';
import * as tenantMeModule from '@/queries/tenantMe';
import type { ProfileMeDto } from '@/queries/profileMe';
import type { TenantMeDto } from '@/queries/tenantMe';
import type { ProfileFormValues, ProfileFormParsed } from '@/lib/validators/profile';
import type { TenantFormValues, TenantFormParsed } from '@/lib/validators/tenant';
import type { ChangePasswordFormValues } from '@/lib/validators/password';

// Stub sonner to avoid ESM import issues in JSDOM
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Capture formRef callbacks so tests can inject dirty state without
// relying on RHF proxy subscriptions outside React render context.
// Radix Tabs requires userEvent (full pointer simulation) to fire onValueChange
// in JSDOM — fireEvent.click does NOT work. Both ProfileForm and TenantForm are
// mocked so we can control the isDirty signal precisely.
type ProfileFormRef = UseFormReturn<ProfileFormValues, unknown, ProfileFormParsed>;
type TenantFormRef = UseFormReturn<TenantFormValues, unknown, TenantFormParsed>;
type PasswordFormRef = UseFormReturn<ChangePasswordFormValues>;

let capturedProfileFormRef: ((f: ProfileFormRef) => void) | undefined;

vi.mock('@/components/settings/ProfileForm', () => ({
  ProfileForm: ({
    profile,
    formRef,
  }: {
    profile: ProfileMeDto;
    formRef?: (f: ProfileFormRef) => void;
  }) => {
    // Capture the formRef callback so tests can inject a fake form instance
    capturedProfileFormRef = formRef;
    return (
      <form>
        <label htmlFor="firstName">Nome</label>
        <input id="firstName" defaultValue={profile.firstName} />
      </form>
    );
  },
}));

// Mock PasswordForm — capture formRef just like ProfileForm.
let capturedPasswordFormRef: ((f: PasswordFormRef) => void) | undefined;
vi.mock('@/components/settings/PasswordForm', () => ({
  PasswordForm: ({ formRef }: { formRef?: (f: PasswordFormRef) => void }) => {
    capturedPasswordFormRef = formRef;
    return (
      <form>
        <label htmlFor="oldPassword">Password attuale</label>
        <input id="oldPassword" type="password" />
      </form>
    );
  },
}));

vi.mock('@/components/settings/TenantForm', () => ({
  TenantForm: ({
    tenant,
    formRef,
  }: {
    tenant: TenantMeDto;
    formRef?: (f: TenantFormRef) => void;
  }) => {
    // formRef is not exercised by tests but typed to satisfy the Props interface
    void formRef;
    return (
      <form>
        <label htmlFor="businessName">Ragione sociale</label>
        <input id="businessName" defaultValue={tenant.businessName} />
      </form>
    );
  },
}));

const profile: ProfileMeDto = {
  id: 'u-1',
  email: 'u@t.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'super_admin',
  tenantId: 't-1',
  locationId: null,
  avatarUrl: null,
  phone: null,
  status: 'active',
  createdAt: '2026-05-15T00:00:00Z',
};

const tenant: TenantMeDto = {
  id: 't-1',
  businessName: 'Officina Rossi',
  vatNumber: null,
  email: 'info@rossi.test',
  phone: null,
  addressLine: null,
  city: null,
  province: null,
  postalCode: null,
  status: 'active',
  plan: 'pilot',
  billingStatus: 'ok',
  createdAt: '2026-05-15T00:00:00Z',
  onboardingCompletedAt: '2026-05-15T00:00:00Z',
};

function wrap(ui: React.ReactNode, { initialPath = '/settings' }: { initialPath?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

// Mock useAuth — AuthContext uses state.status discriminator, not state.kind.
function mockAuthRole(role: 'super_admin' | 'mechanic' | undefined) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({
    state:
      role === undefined
        ? { status: 'unauthenticated' }
        : {
            status: 'authenticated',
            user: {
              email: profile.email,
              givenName: profile.firstName,
              familyName: profile.lastName,
              role,
              tenantId: profile.tenantId,
            },
          },
    signIn: vi.fn(),
    signOut: vi.fn(),
    getIdToken: vi.fn().mockResolvedValue('test-token'),
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

function mockQueries() {
  vi.spyOn(profileMeModule, 'useProfileMe').mockReturnValue({
    data: profile,
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof profileMeModule.useProfileMe>);
  vi.spyOn(tenantMeModule, 'useTenantMe').mockReturnValue({
    data: tenant,
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof tenantMeModule.useTenantMe>);
}

/** Build a fake form API stub with controllable isDirty state.
 * Generic over the form ref type so the same helper works for
 * ProfileFormRef, PasswordFormRef, etc. — the tests only ever
 * exercise formState.isDirty and reset(). */
function makeFakeFormRef<T = ProfileFormRef>(isDirty: boolean) {
  return {
    formState: { isDirty },
    reset: vi.fn(),
  } as unknown as T;
}

describe('Settings page', () => {
  beforeEach(() => {
    mockQueries();
    capturedProfileFormRef = undefined;
    capturedPasswordFormRef = undefined;
    navigateMock.mockReset();
  });

  it('renders both tabs for super_admin', () => {
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    expect(screen.getByRole('tab', { name: 'Profilo' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Officina' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sedi' })).toBeInTheDocument();
  });

  it('renders only Profilo tab for mechanic', () => {
    mockAuthRole('mechanic');
    render(wrap(<Settings />));
    expect(screen.getByRole('tab', { name: 'Profilo' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Officina' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Sedi' })).not.toBeInTheDocument();
  });

  it('switching tab without dirty form is immediate (no AlertDialog)', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    // No formRef injected → anyDirty() = false → tab switches immediately
    await user.click(screen.getByRole('tab', { name: 'Officina' }));
    expect(screen.queryByText('Modifiche non salvate')).not.toBeInTheDocument();
    // Officina tab is now selected
    expect(screen.getByRole('tab', { name: 'Officina' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switching tab with dirty form opens AlertDialog; Annulla keeps current tab', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    // Inject a dirty profile form ref
    capturedProfileFormRef?.(makeFakeFormRef(true));

    // Click Officina tab — should open dialog (form is dirty)
    await user.click(screen.getByRole('tab', { name: 'Officina' }));
    await waitFor(() => {
      expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();
    });

    // Click Annulla — dialog should close, stay on Profilo
    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => {
      expect(screen.queryByText('Modifiche non salvate')).not.toBeInTheDocument();
    });
    // Still on Profilo — Profilo tab is still selected
    expect(screen.getByRole('tab', { name: 'Profilo' })).toHaveAttribute('aria-selected', 'true');
  });

  it('AlertDialog "Continua senza salvare" resets forms and switches tab', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    // Inject a dirty profile form ref with a reset spy
    const fakeForm = makeFakeFormRef(true) as ProfileFormRef & {
      reset: ReturnType<typeof vi.fn>;
    };
    capturedProfileFormRef?.(fakeForm);

    // Click Officina tab — should open dialog
    await user.click(screen.getByRole('tab', { name: 'Officina' }));
    await waitFor(() => {
      expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();
    });

    // Click "Continua senza salvare"
    await user.click(screen.getByRole('button', { name: 'Continua senza salvare' }));
    await waitFor(() => {
      // Officina tab content visible now (Ragione sociale label)
      expect(screen.getByLabelText('Ragione sociale')).toBeInTheDocument();
    });
    // The form's reset was called
    expect(fakeForm.reset).toHaveBeenCalled();
  });

  it('renders Sicurezza tab for both super_admin and mechanic', () => {
    mockAuthRole('mechanic');
    render(wrap(<Settings />));
    expect(screen.getByRole('tab', { name: 'Sicurezza' })).toBeInTheDocument();
  });

  it('dirty password form triggers AlertDialog on tab switch', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    // Switch first to Sicurezza so the form mounts and captures the ref
    await user.click(screen.getByRole('tab', { name: 'Sicurezza' }));
    await waitFor(() => {
      expect(capturedPasswordFormRef).toBeDefined();
    });
    // Inject a dirty password form ref
    capturedPasswordFormRef?.(makeFakeFormRef<PasswordFormRef>(true));

    // Now try to switch back to Profilo — should open dialog
    await user.click(screen.getByRole('tab', { name: 'Profilo' }));
    await waitFor(() => {
      expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();
    });
  });

  it('discardChangesAndSwitch resets the password form too', async () => {
    const user = userEvent.setup();
    mockAuthRole('super_admin');
    render(wrap(<Settings />));
    await user.click(screen.getByRole('tab', { name: 'Sicurezza' }));
    await waitFor(() => {
      expect(capturedPasswordFormRef).toBeDefined();
    });
    const fakePasswordForm = makeFakeFormRef<PasswordFormRef>(true) as PasswordFormRef & {
      reset: ReturnType<typeof vi.fn>;
    };
    capturedPasswordFormRef?.(fakePasswordForm);

    // Switch to Profilo — dialog opens
    await user.click(screen.getByRole('tab', { name: 'Profilo' }));
    await waitFor(() => {
      expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();
    });
    // Click "Continua senza salvare"
    await user.click(screen.getByRole('button', { name: 'Continua senza salvare' }));
    await waitFor(() => {
      expect(screen.queryByText('Modifiche non salvate')).not.toBeInTheDocument();
    });
    expect(fakePasswordForm.reset).toHaveBeenCalled();
  });
});

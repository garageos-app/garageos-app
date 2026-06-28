import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateTenant } from '@/pages/CreateTenant';

// Hoist shared mocks so they are available inside vi.mock factory closures.
// ApiError is re-implemented here so that both the component (which imports it
// from the mocked module) and the test (which uses it directly) share the same
// class reference — preserving instanceof checks inside CreateTenant.tsx.
const { mockApiFetch, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }
  return { mockApiFetch: vi.fn(), MockApiError };
});

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
  ApiError: MockApiError,
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

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('CreateTenant page', () => {
  it('happy path: fills form, submits, shows confirmation with invito text', async () => {
    mockApiFetch.mockResolvedValueOnce({
      tenant: { businessName: 'Officina Test SRL' },
      invitation: { ownerEmail: 'mario@test.it', emailSent: true },
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<CreateTenant />, { wrapper: makeWrapper() });

    await user.type(screen.getByLabelText('Ragione sociale'), 'Officina Test SRL');
    await user.type(screen.getByLabelText('P.IVA'), '12345678901');
    await user.type(screen.getByLabelText('Email officina'), 'officina@test.it');
    await user.type(screen.getByLabelText('Nome titolare'), 'Mario');
    await user.type(screen.getByLabelText('Cognome titolare'), 'Rossi');
    await user.type(screen.getByLabelText('Email titolare'), 'mario@test.it');

    await user.click(screen.getByRole('button', { name: /crea officina/i }));

    // Confirmation heading and invitation text must appear.
    expect(await screen.findByText('Officina creata')).toBeInTheDocument();
    expect(screen.getByText(/invito inviato a/i)).toBeInTheDocument();

    // apiFetch called exactly once with the correct endpoint and JSON body.
    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(mockApiFetch).toHaveBeenCalledWith('/v1/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({
        businessName: 'Officina Test SRL',
        vatNumber: '12345678901',
        email: 'officina@test.it',
        ownerFirstName: 'Mario',
        ownerLastName: 'Rossi',
        ownerEmail: 'mario@test.it',
      }),
    });
  });

  it('error state: tenant.vat_number_duplicate shows Italian alert; form stays visible', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new MockApiError('tenant.vat_number_duplicate', 409, 'VAT già presente'),
    );

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<CreateTenant />, { wrapper: makeWrapper() });

    await user.type(screen.getByLabelText('Ragione sociale'), 'Officina Test SRL');
    await user.type(screen.getByLabelText('P.IVA'), '12345678901');
    await user.type(screen.getByLabelText('Email officina'), 'officina@test.it');
    await user.type(screen.getByLabelText('Nome titolare'), 'Mario');
    await user.type(screen.getByLabelText('Cognome titolare'), 'Rossi');
    await user.type(screen.getByLabelText('Email titolare'), 'mario@test.it');

    await user.click(screen.getByRole('button', { name: /crea officina/i }));

    // Alert region must show the mapped Italian error message.
    expect(await screen.findByRole('alert')).toHaveTextContent('P.IVA già registrata.');
    // Form must still be present (no confirmation switch).
    expect(screen.getByLabelText('Ragione sociale')).toBeInTheDocument();
  });

  it('emailSent=false: warning message appears in confirmation view', async () => {
    mockApiFetch.mockResolvedValueOnce({
      tenant: { businessName: 'Officina Beta SRL' },
      invitation: { ownerEmail: 'beta@test.it', emailSent: false },
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<CreateTenant />, { wrapper: makeWrapper() });

    await user.type(screen.getByLabelText('Ragione sociale'), 'Officina Beta SRL');
    await user.type(screen.getByLabelText('P.IVA'), '98765432109');
    await user.type(screen.getByLabelText('Email officina'), 'beta@officina.it');
    await user.type(screen.getByLabelText('Nome titolare'), 'Luca');
    await user.type(screen.getByLabelText('Cognome titolare'), 'Bianchi');
    await user.type(screen.getByLabelText('Email titolare'), 'beta@test.it');

    await user.click(screen.getByRole('button', { name: /crea officina/i }));

    // Warning line must appear in the confirmation view.
    expect(await screen.findByText(/email non inviata/i)).toBeInTheDocument();
  });
});

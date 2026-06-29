import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { useApiFetch, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  createTenantSchema,
  type CreateTenantValues,
  type CreateTenantParsed,
} from '@/lib/validators/tenant-create';

// Shape of the successful 201 response from POST /v1/admin/tenants.
interface CreateTenantResponse {
  tenant: { businessName: string };
  invitation: { ownerEmail: string; emailSent: boolean };
}

// Maps known API error codes to Italian user-facing messages.
const API_ERROR_MESSAGES: Record<string, string> = {
  'tenant.vat_number_duplicate': 'P.IVA già registrata.',
  'tenant.vat_number_invalid': 'P.IVA non valida (11 cifre).',
  'user.invitation.email_in_other_tenant': "Email titolare già usata in un'altra officina.",
  'auth.cognito_unavailable': 'Servizio temporaneamente non disponibile, riprova.',
};

function mapApiError(err: ApiError): string {
  return API_ERROR_MESSAGES[err.code] ?? err.message;
}

export function CreateTenant() {
  const apiFetch = useApiFetch();
  const [apiError, setApiError] = useState<string | null>(null);
  const [confirmationData, setConfirmationData] = useState<CreateTenantResponse | null>(null);

  const form = useForm<CreateTenantValues, unknown, CreateTenantParsed>({
    resolver: zodResolver(createTenantSchema),
    defaultValues: {
      businessName: '',
      vatNumber: '',
      email: '',
      ownerFirstName: '',
      ownerLastName: '',
      ownerEmail: '',
    },
  });

  async function onSubmit(values: CreateTenantParsed) {
    setApiError(null);
    try {
      const res = await apiFetch<CreateTenantResponse>('/v1/admin/tenants', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setConfirmationData(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setApiError(mapApiError(err));
      } else {
        setApiError('Errore sconosciuto. Riprova.');
      }
    }
  }

  function resetForm() {
    form.reset();
    setConfirmationData(null);
    setApiError(null);
  }

  // Confirmation view — shown after a successful creation.
  if (confirmationData !== null) {
    const { tenant, invitation } = confirmationData;
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-2xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>Officina creata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>
                <strong>{tenant.businessName}</strong> creata. Invito inviato a{' '}
                <strong>{invitation.ownerEmail}</strong>. Il link di accesso scade tra 7 giorni.
              </p>
              {invitation.emailSent === false && (
                <p className="text-amber-700">
                  Attenzione: Email non inviata.{' '}
                  <Link to="/officine" className="underline">
                    Se l&apos;email non arriva, rigenera il link dalla lista Officine.
                  </Link>
                </p>
              )}
              <Button onClick={resetForm}>Crea un&apos;altra officina</Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Form view — initial state and after an API error.
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Crea officina</CardTitle>
          </CardHeader>
          <CardContent>
            {apiError && (
              <div
                role="alert"
                className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
              >
                {apiError}
              </div>
            )}
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="businessName">Ragione sociale</Label>
                <Input id="businessName" {...form.register('businessName')} />
                {form.formState.errors.businessName && (
                  <p className="text-sm text-red-600">
                    {form.formState.errors.businessName.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="vatNumber">P.IVA</Label>
                <Input id="vatNumber" {...form.register('vatNumber')} />
                {form.formState.errors.vatNumber && (
                  <p className="text-sm text-red-600">{form.formState.errors.vatNumber.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email officina</Label>
                <Input id="email" type="email" {...form.register('email')} />
                {form.formState.errors.email && (
                  <p className="text-sm text-red-600">{form.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="ownerFirstName">Nome titolare</Label>
                <Input id="ownerFirstName" {...form.register('ownerFirstName')} />
                {form.formState.errors.ownerFirstName && (
                  <p className="text-sm text-red-600">
                    {form.formState.errors.ownerFirstName.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="ownerLastName">Cognome titolare</Label>
                <Input id="ownerLastName" {...form.register('ownerLastName')} />
                {form.formState.errors.ownerLastName && (
                  <p className="text-sm text-red-600">
                    {form.formState.errors.ownerLastName.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="ownerEmail">Email titolare</Label>
                <Input id="ownerEmail" type="email" {...form.register('ownerEmail')} />
                {form.formState.errors.ownerEmail && (
                  <p className="text-sm text-red-600">{form.formState.errors.ownerEmail.message}</p>
                )}
              </div>

              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Invio...' : 'Crea officina'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

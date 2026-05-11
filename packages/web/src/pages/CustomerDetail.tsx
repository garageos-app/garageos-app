// IT-strings — hardcoded
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { ApiError } from '@/lib/api-client';
import { formToPatch, type CustomerFormValues } from '@/lib/customer-form';
import { useCustomerDetail, useUpdateCustomer } from '@/queries/customerDetail';
import type { CustomerDetail as CustomerDetailDto } from '@/queries/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type Mode = 'view' | 'edit';

// ---------------------------------------------------------------------------
// Edit-mode form schema
// ---------------------------------------------------------------------------

const formSchema = z.object({
  firstName: z.string().min(1, 'Nome richiesto').max(100),
  lastName: z.string().min(1, 'Cognome richiesto').max(100),
  phone: z.string().max(30),
  taxCode: z.string().max(20),
  isBusiness: z.boolean(),
  businessName: z.string().max(200),
  vatNumber: z.string().max(20),
  addressLine: z.string().max(255),
  city: z.string().max(100),
  province: z.string().max(2),
  postalCode: z.string().max(10),
  tenantNotes: z.string().max(5000),
});

// CustomerFormValues is imported from '@/lib/customer-form' (extracted voce 10).
// The Zod schema infers the same shape — validated at call sites via zodResolver.

function dtoToFormDefaults(dto: CustomerDetailDto): CustomerFormValues {
  return {
    firstName: dto.firstName,
    lastName: dto.lastName,
    phone: dto.phone ?? '',
    taxCode: dto.taxCode ?? '',
    isBusiness: dto.isBusiness,
    businessName: dto.businessName ?? '',
    vatNumber: dto.vatNumber ?? '',
    addressLine: dto.addressLine ?? '',
    city: dto.city ?? '',
    province: dto.province ?? '',
    postalCode: dto.postalCode ?? '',
    tenantNotes: dto.tenantRelation.tenantNotes ?? '',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export function CustomerDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('view');
  const detail = useCustomerDetail(id);

  useEffect(() => {
    if (detail.isError && detail.error instanceof ApiError && detail.error.status === 404) {
      toast.error('Cliente non trovato');
      navigate('/', { replace: true });
    }
  }, [detail.isError, detail.error, navigate]);

  if (detail.isPending) {
    return (
      <div className="p-8 space-y-6" data-testid="customer-detail-skeleton">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (detail.isError) {
    // 404 already redirected above; this branch covers other 4xx/5xx.
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              {detail.error instanceof Error ? detail.error.message : 'Errore sconosciuto'}
            </span>
            <Button size="sm" variant="outline" onClick={() => detail.refetch()}>
              Riprova
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return mode === 'edit' ? (
    <EditMode
      dto={detail.data}
      customerId={id}
      onCancel={() => setMode('view')}
      onSaved={() => setMode('view')}
    />
  ) : (
    <ViewMode dto={detail.data} onEdit={() => setMode('edit')} />
  );
}

// ---------------------------------------------------------------------------
// EditMode
// ---------------------------------------------------------------------------

function EditMode({
  dto,
  customerId,
  onCancel,
  onSaved,
}: {
  dto: CustomerDetailDto;
  customerId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const update = useUpdateCustomer(customerId);
  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: dtoToFormDefaults(dto),
  });
  const isBusiness = form.watch('isBusiness');

  // Voce 11: hard-reset business fields when user toggles isBusiness off.
  // Coherent with backend (a private customer has no business identity)
  // and avoids hidden form state that would silently resurface on toggle-on.
  useEffect(() => {
    if (!isBusiness) {
      form.setValue('businessName', '');
      form.setValue('vatNumber', '');
    }
  }, [isBusiness, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const patch = formToPatch(values, dto);
    if (Object.keys(patch).length === 0) {
      // No changes — no PATCH, just exit edit mode.
      onSaved();
      return;
    }
    try {
      await update.mutateAsync(patch);
      toast.success('Cliente aggiornato');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.error('Cliente non più accessibile');
        navigate('/', { replace: true });
        return;
      }
      const code = err instanceof ApiError ? err.code : undefined;
      toast.error(code ? `Errore: ${code}` : 'Errore durante il salvataggio');
    }
  });

  return (
    <form onSubmit={onSubmit} className="p-8 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Modifica cliente</h1>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={update.isPending}>
            Annulla
          </Button>
          <Button type="submit" disabled={update.isPending}>
            Salva
          </Button>
        </div>
      </header>

      {/* Voce 9: B2C-registered warning — customer has a mobile app account. */}
      {dto.cognitoSub && (
        <Alert>
          <AlertDescription>
            <strong>Cliente registrato</strong> — le modifiche propagano al profilo mobile del
            cliente.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Anagrafica</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Labelled id="firstName" label="Nome" error={form.formState.errors.firstName?.message}>
            <Input id="firstName" {...form.register('firstName')} />
          </Labelled>
          <Labelled id="lastName" label="Cognome" error={form.formState.errors.lastName?.message}>
            <Input id="lastName" {...form.register('lastName')} />
          </Labelled>
          <Labelled
            id="taxCode"
            label="Codice fiscale"
            error={form.formState.errors.taxCode?.message}
          >
            <Input id="taxCode" {...form.register('taxCode')} />
          </Labelled>
          <div className="flex items-center gap-3 pt-2">
            <Switch
              id="isBusiness"
              checked={isBusiness}
              onCheckedChange={(v) => form.setValue('isBusiness', v)}
              aria-label="Cliente B2B"
            />
            <Label htmlFor="isBusiness">Cliente B2B</Label>
          </div>
          {isBusiness && (
            <>
              <Labelled
                id="businessName"
                label="Ragione sociale"
                error={form.formState.errors.businessName?.message}
              >
                <Input id="businessName" {...form.register('businessName')} />
              </Labelled>
              <Labelled
                id="vatNumber"
                label="P.IVA"
                error={form.formState.errors.vatNumber?.message}
              >
                <Input id="vatNumber" {...form.register('vatNumber')} />
              </Labelled>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contatti</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Labelled id="email" label="Email">
            <Input id="email" disabled value={dto.email} aria-label="Email" />
            <span className="text-xs text-muted-foreground">Modificabile solo dal cliente</span>
          </Labelled>
          <Labelled id="phone" label="Telefono" error={form.formState.errors.phone?.message}>
            <Input id="phone" {...form.register('phone')} />
          </Labelled>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Indirizzo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Labelled
            id="addressLine"
            label="Indirizzo"
            error={form.formState.errors.addressLine?.message}
          >
            <Input id="addressLine" {...form.register('addressLine')} />
          </Labelled>
          <div className="grid grid-cols-3 gap-3">
            <Labelled id="postalCode" label="CAP" error={form.formState.errors.postalCode?.message}>
              <Input id="postalCode" {...form.register('postalCode')} />
            </Labelled>
            <Labelled id="city" label="Città" error={form.formState.errors.city?.message}>
              <Input id="city" {...form.register('city')} />
            </Labelled>
            <Labelled id="province" label="Prov." error={form.formState.errors.province?.message}>
              <Input id="province" maxLength={2} {...form.register('province')} />
            </Labelled>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Note officina (private)</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            id="tenantNotes"
            rows={4}
            aria-label="Note officina"
            {...form.register('tenantNotes')}
          />
        </CardContent>
      </Card>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ViewMode
// ---------------------------------------------------------------------------

function ViewMode({ dto, onEdit }: { dto: CustomerDetailDto; onEdit: () => void }) {
  const displayName =
    dto.isBusiness && dto.businessName ? dto.businessName : `${dto.firstName} ${dto.lastName}`;

  const addressOneLine = [dto.addressLine, dto.postalCode, dto.city, dto.province]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="p-8 space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{displayName}</h1>
          <div className="text-sm text-muted-foreground mt-1">
            {dto.email}
            {dto.phone ? <> · {dto.phone}</> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {dto.isBusiness && <Badge variant="secondary">B2B</Badge>}
          <Button onClick={onEdit}>Modifica</Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Anagrafica</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Field label="Nome">{dto.firstName}</Field>
          <Field label="Cognome">{dto.lastName}</Field>
          <Field label="Codice fiscale">{dto.taxCode ?? '—'}</Field>
          {dto.isBusiness && (
            <>
              <Field label="Ragione sociale">{dto.businessName ?? '—'}</Field>
              <Field label="P.IVA">{dto.vatNumber ?? '—'}</Field>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contatti</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Field label="Email">
            <span>{dto.email}</span>
            <Badge variant="outline" className="ml-2">
              non modificabile
            </Badge>
          </Field>
          <Field label="Telefono">{dto.phone ?? '—'}</Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Indirizzo</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {addressOneLine ? <p>{addressOneLine}</p> : <p>—</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Note officina (private)</CardTitle>
        </CardHeader>
        <CardContent className="text-sm whitespace-pre-line">
          {dto.tenantRelation.tenantNotes || '—'}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storia con questa officina</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Field label="Numero interventi">{dto.tenantRelation.interventionCount}</Field>
          <Field label="Primo intervento">
            {formatDate(dto.tenantRelation.firstInterventionAt)}
          </Field>
          <Field label="Ultimo intervento">
            {formatDate(dto.tenantRelation.lastInterventionAt)}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Veicoli ({dto.vehicles.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {dto.vehicles.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessun veicolo associato.</p>
          ) : (
            <ul className="divide-y">
              {dto.vehicles.map((v) => (
                <li key={v.id}>
                  <Link to={`/vehicles/${v.id}`} className="block py-2 hover:underline">
                    {v.plate} · {v.make} {v.model} ({v.year})
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Labelled({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

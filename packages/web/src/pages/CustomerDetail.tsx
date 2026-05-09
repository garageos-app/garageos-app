// IT-strings — hardcoded
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { useCustomerDetail } from '@/queries/customerDetail';
import type { CustomerDetail as CustomerDetailDto } from '@/queries/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type Mode = 'view' | 'edit';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

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

  // mode === 'edit' branch is implemented in Task 8b.
  // setMode is used below via onEdit; the edit branch will be added in Task 8b.
  return <ViewMode dto={detail.data} onEdit={() => setMode('edit')} mode={mode} />;
}

function ViewMode({ dto, onEdit }: { dto: CustomerDetailDto; onEdit: () => void; mode: Mode }) {
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

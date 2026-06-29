import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import { STATUS_BADGE, INVITATION_BADGE } from '@/lib/tenant-status';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ─── Wire type (mirrors TenantAdminListItem in packages/api/src/lib/dtos/tenant-admin.ts) ────

export interface TenantAdminListItem {
  id: string;
  businessName: string;
  vatNumber: string;
  email: string;
  status: 'active' | 'suspended' | 'pending' | 'cancelled';
  createdAt: string; // ISO-8601
  owner: { email: string; invitationStatus: 'pending' | 'accepted' | 'expired' } | null;
}

// ─── Filter options ────────────────────────────────────────────────────────────

type FilterStatus = 'all' | 'active' | 'suspended';

const FILTER_OPTIONS: { value: FilterStatus; label: string }[] = [
  { value: 'all', label: 'Tutte' },
  { value: 'active', label: 'Attive' },
  { value: 'suspended', label: 'Sospese' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function TenantList() {
  const apiFetch = useApiFetch();
  const [filter, setFilter] = useState<FilterStatus>('all');

  const { data, isLoading, error } = useQuery<{ tenants: TenantAdminListItem[] }>({
    queryKey: ['admin-tenants'],
    queryFn: () => apiFetch<{ tenants: TenantAdminListItem[] }>('/v1/admin/tenants'),
  });

  // Error check first — when the query fails, isLoading is false but data is
  // also undefined, so we must check error before the isLoading||!data guard.
  if (error) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-6xl mx-auto">
          <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
            Errore nel caricamento delle officine.
          </div>
        </div>
      </div>
    );
  }

  // Loading state — also guards against offline/paused state where data may be
  // undefined even though isLoading is false. See [[feedback_react_query_data_bang_offline_paused]].
  if (isLoading || !data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-6xl mx-auto">
          <p className="text-muted-foreground">Caricamento…</p>
        </div>
      </div>
    );
  }

  // Client-side filter
  const filtered =
    filter === 'all' ? data.tenants : data.tenants.filter((t) => t.status === filter);

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Officine</h1>

        {/* Status filter */}
        <div className="flex gap-2 mb-4">
          {FILTER_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={[
                'px-3 py-1.5 text-sm rounded-md border transition-colors',
                filter === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-foreground border-border hover:bg-muted',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="text-muted-foreground">Nessuna officina.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Officina</TableHead>
                <TableHead>P.IVA</TableHead>
                <TableHead>Email titolare</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Invito</TableHead>
                <TableHead>Creata</TableHead>
                <TableHead>Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((tenant) => {
                const statusBadge = STATUS_BADGE[tenant.status];
                return (
                  <TableRow key={tenant.id}>
                    <TableCell className="font-medium">{tenant.businessName}</TableCell>
                    <TableCell>{tenant.vatNumber}</TableCell>
                    <TableCell>{tenant.owner?.email ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {tenant.owner ? (
                        <Badge variant={INVITATION_BADGE[tenant.owner.invitationStatus].variant}>
                          {INVITATION_BADGE[tenant.owner.invitationStatus].label}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{new Date(tenant.createdAt).toLocaleDateString('it-IT')}</TableCell>
                    <TableCell>{/* T8 fills row actions */}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

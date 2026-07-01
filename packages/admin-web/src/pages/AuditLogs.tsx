import { useState } from 'react';
import { useQuery, useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-client';
import type { TenantAdminListItem } from '@/lib/tenant-types';
import { ACTOR_TYPE_LABELS, AUDIT_ACTIONS } from '@/lib/audit-types';
import type { AuditLogItem, AuditLogPage } from '@/lib/audit-types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ─── Filter state ─────────────────────────────────────────────────────────────

interface AuditFilters {
  tenantId: string; // '' | 'platform' | UUID
  action: string;
  actorType: string;
  from: string; // YYYY-MM-DD or ''
  to: string; // YYYY-MM-DD or ''
}

const INITIAL_FILTERS: AuditFilters = {
  tenantId: '',
  action: '',
  actorType: '',
  from: '',
  to: '',
};

// ─── URL builder ─────────────────────────────────────────────────────────────

// Builds the paginated query URL from filter state and optional cursor.
// Date params are converted to full-day ISO ranges; empty controls are omitted.
// Boundaries are built in LOCAL time (no 'Z') so they align with the table's
// `toLocaleString('it-IT')` rendering — a UTC-day range would disagree with
// the visible date column near midnight. toISOString() still sends a valid UTC
// instant; only the wall-clock interpretation matches the operator's locale.
function buildUrl(filters: AuditFilters, cursor: string | undefined): string {
  const params = new URLSearchParams();
  if (filters.tenantId) params.set('tenantId', filters.tenantId);
  if (filters.action) params.set('action', filters.action);
  if (filters.actorType) params.set('actorType', filters.actorType);
  if (filters.from) {
    params.set('from', new Date(filters.from + 'T00:00:00.000').toISOString());
  }
  if (filters.to) {
    params.set('to', new Date(filters.to + 'T23:59:59.999').toISOString());
  }
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return `/v1/admin/audit-logs${qs ? `?${qs}` : ''}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Maps tenant shape to display label.
// tenant === null → platform event; businessName === null → hard-deleted tenant.
function getTenantLabel(tenant: AuditLogItem['tenant']): string {
  if (tenant === null) return 'Eventi piattaforma';
  return tenant.businessName ?? 'Officina eliminata';
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AuditLogs() {
  const apiFetch = useApiFetch();
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS);
  const [selected, setSelected] = useState<AuditLogItem | null>(null);

  // Officina dropdown — reuses admin-tenants cache populated by TenantList.
  const tenantsQuery = useQuery<{ tenants: TenantAdminListItem[] }>({
    queryKey: ['admin-tenants'],
    queryFn: () => apiFetch<{ tenants: TenantAdminListItem[] }>('/v1/admin/tenants'),
  });

  // Audit log paginated query (keyset cursor).
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery<
      AuditLogPage,
      Error,
      InfiniteData<AuditLogPage>,
      (string | AuditFilters)[],
      string | undefined
    >({
      queryKey: ['admin-audit-logs', filters],
      queryFn: ({ pageParam }) => apiFetch<AuditLogPage>(buildUrl(filters, pageParam)),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    });

  // ── Error / loading guards (error before isLoading — mirror TenantList) ─────

  if (error) {
    return (
      <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
        Errore nel caricamento degli audit log.
      </div>
    );
  }

  if (isLoading || !data) {
    return <p className="text-muted-foreground">Caricamento…</p>;
  }

  const items = data.pages.flatMap((p) => p.items);

  return (
    <div className="space-y-6">
      {/* ── Filters ─────────────────────────────────────────────────────── */}
      {/* Native <select> and <input> — avoids Radix Select pointer-capture
            issues in JSDOM. See [[feedback_radix_select_jsdom_pointer_polyfill]]. */}
      <div className="flex flex-wrap gap-4 mb-6">
        {/* Officina */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-tenant" className="text-sm font-medium">
            Officina
          </label>
          <select
            id="filter-tenant"
            value={filters.tenantId}
            onChange={(e) => setFilters((f) => ({ ...f, tenantId: e.target.value }))}
            className="border rounded px-2 py-1 text-sm bg-background"
          >
            <option value="">Tutte</option>
            <option value="platform">Eventi piattaforma</option>
            {tenantsQuery.data?.tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.businessName}
              </option>
            ))}
          </select>
        </div>

        {/* Azione */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-action" className="text-sm font-medium">
            Azione
          </label>
          <select
            id="filter-action"
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
            className="border rounded px-2 py-1 text-sm bg-background"
          >
            <option value="">Tutte</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        {/* Tipo attore */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-actor-type" className="text-sm font-medium">
            Tipo attore
          </label>
          <select
            id="filter-actor-type"
            value={filters.actorType}
            onChange={(e) => setFilters((f) => ({ ...f, actorType: e.target.value }))}
            className="border rounded px-2 py-1 text-sm bg-background"
          >
            <option value="">Tutti</option>
            {(Object.keys(ACTOR_TYPE_LABELS) as AuditLogItem['actorType'][]).map((key) => (
              <option key={key} value={key}>
                {ACTOR_TYPE_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        {/* Periodo Da */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-from" className="text-sm font-medium">
            Da
          </label>
          <input
            id="filter-from"
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            className="border rounded px-2 py-1 text-sm bg-background"
          />
        </div>

        {/* Periodo A */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-to" className="text-sm font-medium">
            A
          </label>
          <input
            id="filter-to"
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            className="border rounded px-2 py-1 text-sm bg-background"
          />
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      {items.length === 0 ? (
        <p className="text-muted-foreground">Nessun evento.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Officina</TableHead>
                <TableHead>Attore</TableHead>
                <TableHead>Azione</TableHead>
                <TableHead>Entità</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(item)}
                >
                  <TableCell>{new Date(item.createdAt).toLocaleString('it-IT')}</TableCell>
                  <TableCell>{getTenantLabel(item.tenant)}</TableCell>
                  <TableCell>{ACTOR_TYPE_LABELS[item.actorType]}</TableCell>
                  <TableCell>{item.action}</TableCell>
                  <TableCell>{item.entityType}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                Carica altri
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── Detail Dialog ────────────────────────────────────────────────── */}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dettaglio evento</DialogTitle>
            <DialogDescription>Riepilogo dell&apos;evento di audit selezionato.</DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div>
                <span className="font-medium">Azione:</span> {selected.action}
              </div>
              <div>
                <span className="font-medium">Entità:</span> {selected.entityType} /{' '}
                {selected.entityId}
              </div>
              <div>
                <span className="font-medium">Attore ID:</span> {selected.actorId ?? '—'}
              </div>
              <div>
                <span className="font-medium">IP:</span> {selected.ipAddress ?? '—'}
              </div>
              <div>
                <span className="font-medium">Metadati:</span>
                <pre className="text-xs overflow-auto mt-1 bg-muted p-2 rounded">
                  {JSON.stringify(selected.metadata, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

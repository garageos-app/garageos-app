import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useApiFetch, ApiError } from '@/lib/api-client';
import { STATUS_BADGE, INVITATION_BADGE } from '@/lib/tenant-status';
import { ACTION_ERROR_MESSAGES, GENERIC_ACTION_ERROR } from '@/lib/tenant-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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

// ─── Response types ───────────────────────────────────────────────────────────

interface RegenerateResult {
  ownerEmail: string;
  expiresAt: string;
  emailSent: boolean;
  magicLinkUrl: string;
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
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterStatus>('all');

  // Dialog state — null means closed.
  const [suspendTarget, setSuspendTarget] = useState<{
    id: string;
    businessName: string;
  } | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<{
    id: string;
    businessName: string;
  } | null>(null);
  const [regenerateResult, setRegenerateResult] = useState<RegenerateResult | null>(null);

  const { data, isLoading, error } = useQuery<{ tenants: TenantAdminListItem[] }>({
    queryKey: ['admin-tenants'],
    queryFn: () => apiFetch<{ tenants: TenantAdminListItem[] }>('/v1/admin/tenants'),
  });

  // ── Shared error handler ─────────────────────────────────────────────────────

  function handleMutationError(err: unknown) {
    if (err instanceof ApiError) {
      toast.error(ACTION_ERROR_MESSAGES[err.code] ?? GENERIC_ACTION_ERROR);
    } else {
      toast.error(GENERIC_ACTION_ERROR);
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  // Suspend: active → suspended (BR-210)
  const suspendMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ tenant: { id: string; status: string } }>(`/v1/admin/tenants/${id}/suspend`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast.success('Officina sospesa.');
      setSuspendTarget(null);
    },
    onError: handleMutationError,
  });

  // Reactivate: suspended → active (BR-210)
  const reactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ tenant: { id: string; status: string } }>(`/v1/admin/tenants/${id}/reactivate`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast.success('Officina riattivata.');
      setReactivateTarget(null);
    },
    onError: handleMutationError,
  });

  // Regenerate invitation link — only for active tenants with an unaccepted invitation
  const regenerateMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ invitation: RegenerateResult }>(`/v1/admin/tenants/${id}/regenerate-invitation`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast.success('Link di invito rigenerato.');
      setRegenerateResult(data.invitation);
    },
    onError: handleMutationError,
  });

  // ── Error / loading guards ───────────────────────────────────────────────────

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
                // Show Rigenera link only for active tenants with an unaccepted invitation.
                const showRigenera =
                  tenant.status === 'active' &&
                  tenant.owner !== null &&
                  tenant.owner.invitationStatus !== 'accepted';

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
                    <TableCell>
                      <div className="flex gap-2 flex-wrap">
                        {tenant.status === 'active' && (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={suspendMutation.isPending}
                            onClick={() =>
                              setSuspendTarget({
                                id: tenant.id,
                                businessName: tenant.businessName,
                              })
                            }
                          >
                            Sospendi
                          </Button>
                        )}
                        {tenant.status === 'suspended' && (
                          <Button
                            variant="default"
                            size="sm"
                            disabled={reactivateMutation.isPending}
                            onClick={() =>
                              setReactivateTarget({
                                id: tenant.id,
                                businessName: tenant.businessName,
                              })
                            }
                          >
                            Riattiva
                          </Button>
                        )}
                        {showRigenera && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={regenerateMutation.isPending}
                            onClick={() => regenerateMutation.mutate(tenant.id)}
                          >
                            Rigenera link
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ── Suspend confirm dialog ──────────────────────────────────────────── */}
      <AlertDialog
        open={suspendTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSuspendTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sospendi officina</AlertDialogTitle>
            <AlertDialogDescription>
              Sospendere {suspendTarget?.businessName}? Gli utenti dell&apos;officina non potranno
              più accedere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={suspendMutation.isPending}>Annulla</AlertDialogCancel>
            <AlertDialogAction
              disabled={suspendMutation.isPending}
              onClick={(e) => {
                // Prevent the AlertDialog from closing before the mutation resolves;
                // onSuccess closes it explicitly via setSuspendTarget(null).
                e.preventDefault();
                if (suspendTarget) suspendMutation.mutate(suspendTarget.id);
              }}
            >
              Sospendi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reactivate confirm dialog ───────────────────────────────────────── */}
      <AlertDialog
        open={reactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReactivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Riattiva officina</AlertDialogTitle>
            <AlertDialogDescription>
              Riattivare {reactivateTarget?.businessName}? Gli utenti dell&apos;officina potranno
              nuovamente accedere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reactivateMutation.isPending}>Annulla</AlertDialogCancel>
            <AlertDialogAction
              disabled={reactivateMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (reactivateTarget) reactivateMutation.mutate(reactivateTarget.id);
              }}
            >
              Riattiva
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Regenerate invitation result dialog ─────────────────────────────── */}
      <Dialog
        open={regenerateResult !== null}
        onOpenChange={(open) => {
          if (!open) setRegenerateResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link di invito rigenerato</DialogTitle>
            <DialogDescription>
              {regenerateResult?.emailSent
                ? `Email inviata a ${regenerateResult.ownerEmail}.`
                : 'Email non inviata — copia il link e invialo manualmente.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input readOnly value={regenerateResult?.magicLinkUrl ?? ''} aria-label="Magic link" />
            <Button
              variant="outline"
              onClick={() => {
                if (regenerateResult) {
                  void navigator.clipboard.writeText(regenerateResult.magicLinkUrl);
                  toast.success('Link copiato negli appunti.');
                }
              }}
            >
              Copia
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

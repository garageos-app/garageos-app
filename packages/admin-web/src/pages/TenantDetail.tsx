import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useApiFetch, ApiError } from '@/lib/api-client';
import { STATUS_BADGE } from '@/lib/tenant-status';
import { ACTION_ERROR_MESSAGES, GENERIC_ACTION_ERROR } from '@/lib/tenant-actions';
import type { TenantProfile, AdminUser, InviteResult } from '@/lib/tenant-detail-types';
import type { TenantMetrics } from '@/lib/metrics-types';
import { StatCard } from '@/components/StatCard';
import {
  tenantProfileSchema,
  type TenantProfileValues,
  type TenantProfileParsed,
} from '@/lib/validators/tenant-profile';
import {
  userInviteSchema,
  type UserInviteValues,
  type UserInviteParsed,
} from '@/lib/validators/user-invite';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

export function TenantDetail() {
  // id is always defined when this component is mounted via <Route path="/officine/:id" />.
  const { id } = useParams<{ id: string }>();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  // ── Dialog state ─────────────────────────────────────────────────────────────
  // null means closed; populated with target data means open.
  const [disableTarget, setDisableTarget] = useState<{
    userId: string;
    name: string;
  } | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<{
    userId: string;
    name: string;
  } | null>(null);
  const [roleTarget, setRoleTarget] = useState<{
    userId: string;
    name: string;
    newRole: 'super_admin' | 'mechanic';
  } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);

  // ── Tenant profile query ───────────────────────────────────────────────────
  const { data, isLoading, error } = useQuery<{ tenant: TenantProfile }>({
    queryKey: ['admin-tenant', id],
    queryFn: () => apiFetch(`/v1/admin/tenants/${id!}`),
    enabled: !!id,
  });

  // Use `values` (not `defaultValues`) so the form resets automatically when
  // the query data arrives — see react-hook-form docs on controlled forms.
  const form = useForm<TenantProfileValues, unknown, TenantProfileParsed>({
    resolver: zodResolver(tenantProfileSchema),
    values: data
      ? {
          businessName: data.tenant.businessName,
          vatNumber: data.tenant.vatNumber,
          email: data.tenant.email,
          // Nullable string fields: null → '' for the input, '' → null after Zod transform.
          phone: data.tenant.phone ?? '',
          addressLine: data.tenant.addressLine ?? '',
          city: data.tenant.city ?? '',
          province: data.tenant.province ?? '',
          postalCode: data.tenant.postalCode ?? '',
        }
      : {
          businessName: '',
          vatNumber: '',
          email: '',
          phone: '',
          addressLine: '',
          city: '',
          province: '',
          postalCode: '',
        },
  });

  // ── Users query ──────────────────────────────────────────────────────────────
  // Independent of the profile query — owns its own loading/error state so a
  // users-endpoint failure does not block the rest of the page.
  const {
    data: usersData,
    isLoading: usersLoading,
    error: usersError,
  } = useQuery<{ users: AdminUser[] }>({
    queryKey: ['admin-tenant-users', id],
    queryFn: () => apiFetch(`/v1/admin/tenants/${id!}/users`),
    enabled: !!id,
  });

  // ── Metrics query ────────────────────────────────────────────────────────────
  // Independent of profile/users — its own loading/error state so a metrics
  // failure does not block the rest of the page.
  const {
    data: metricsData,
    isLoading: metricsLoading,
    error: metricsError,
  } = useQuery<TenantMetrics>({
    queryKey: ['admin-tenant-metrics', id],
    queryFn: () => apiFetch(`/v1/admin/tenants/${id!}/metrics`),
    enabled: !!id,
  });

  // ── Invite form ──────────────────────────────────────────────────────────────
  // Separate form instance so it does not interfere with the profile form above.
  const inviteForm = useForm<UserInviteValues, unknown, UserInviteParsed>({
    resolver: zodResolver(userInviteSchema),
    defaultValues: { email: '', firstName: '', lastName: '', role: 'mechanic' },
  });

  // ── Shared error handler (mirrors TenantList.tsx exactly) ────────────────────
  function handleMutationError(err: unknown) {
    if (err instanceof ApiError) {
      // api-client already fired toast.error('Sessione scaduta…') and signed the user
      // out for these codes — do not stack a second contradictory toast.
      if (err.code === 'auth.expired' || err.code === 'auth.no_token') return;
      toast.error(ACTION_ERROR_MESSAGES[err.code] ?? GENERIC_ACTION_ERROR);
    } else {
      toast.error(GENERIC_ACTION_ERROR);
    }
  }

  // ── Profile update mutation ───────────────────────────────────────────────────
  const updateMutation = useMutation({
    mutationFn: (vals: TenantProfileParsed) =>
      apiFetch<{ tenant: TenantProfile }>(`/v1/admin/tenants/${id!}`, {
        method: 'PATCH',
        body: JSON.stringify(vals),
      }),
    onSuccess: () => {
      // Invalidate both the detail cache and the list cache so both pages stay fresh.
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant', id] });
      void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast.success('Dati officina aggiornati.');
    },
    // Use the shared handler so auth-expiry codes are silenced the same way as
    // all other mutations on this page (no second contradictory toast).
    onError: handleMutationError,
  });

  // ── User action mutations ─────────────────────────────────────────────────────
  // PATCH /v1/admin/tenants/:id/users/:userId — body is non-empty so no empty-JSON
  // workaround is needed (contrast with lifecycle POST endpoints in TenantList.tsx).

  const disableMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/v1/admin/tenants/${id!}/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'inactive' }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant-users', id] });
      toast.success('Utente disabilitato.');
      setDisableTarget(null);
    },
    onError: handleMutationError,
  });

  const reactivateUserMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/v1/admin/tenants/${id!}/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant-users', id] });
      toast.success('Utente riattivato.');
      setReactivateTarget(null);
    },
    onError: handleMutationError,
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, newRole }: { userId: string; newRole: 'super_admin' | 'mechanic' }) =>
      apiFetch(`/v1/admin/tenants/${id!}/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant-users', id] });
      toast.success('Ruolo aggiornato.');
      setRoleTarget(null);
    },
    onError: handleMutationError,
  });

  const inviteMutation = useMutation({
    mutationFn: (vals: UserInviteParsed) =>
      apiFetch<{ invitation: InviteResult }>(`/v1/admin/tenants/${id!}/users/invitations`, {
        method: 'POST',
        body: JSON.stringify(vals),
      }),
    onSuccess: (responseData) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant-users', id] });
      toast.success('Invito inviato.');
      setInviteOpen(false);
      inviteForm.reset();
      setInviteResult(responseData.invitation);
    },
    onError: handleMutationError,
  });

  // ── Guards ────────────────────────────────────────────────────────────────────

  // Error check first — when the query fails, isLoading is false but data is
  // also undefined, so we must check error before the isLoading||!data guard.
  // Mirrors the guard order in TenantList.tsx.
  if (error) {
    return (
      <div className="max-w-3xl space-y-4">
        <Link to="/officine" className="text-sm text-muted-foreground hover:underline inline-block">
          ← Officine
        </Link>
        <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
          Errore nel caricamento dell&apos;officina.
        </div>
      </div>
    );
  }

  // Loading state — also guards against offline/paused state where data may be
  // undefined even though isLoading is false.
  // See [[feedback_react_query_data_bang_offline_paused]].
  if (isLoading || !data) {
    return (
      <div className="max-w-3xl space-y-4">
        <Link to="/officine" className="text-sm text-muted-foreground hover:underline inline-block">
          ← Officine
        </Link>
        <p className="text-muted-foreground">Caricamento…</p>
      </div>
    );
  }

  const statusBadge = STATUS_BADGE[data.tenant.status];

  function onSubmit(vals: TenantProfileParsed) {
    updateMutation.mutate(vals);
  }

  function onInviteSubmit(vals: UserInviteParsed) {
    inviteMutation.mutate(vals);
  }

  return (
    <>
      <div className="max-w-3xl mx-auto">
        <Link
          to="/officine"
          className="text-sm text-muted-foreground hover:underline mb-4 inline-block"
        >
          ← Officine
        </Link>

        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-2xl font-bold">{data.tenant.businessName}</h1>
          <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
        </div>

        {/* ── Profile section ───────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Profilo officina</CardTitle>
          </CardHeader>
          <CardContent>
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
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" {...form.register('email')} />
                {form.formState.errors.email && (
                  <p className="text-sm text-red-600">{form.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Telefono</Label>
                <Input id="phone" {...form.register('phone')} />
                {form.formState.errors.phone && (
                  <p className="text-sm text-red-600">{form.formState.errors.phone.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="addressLine">Indirizzo</Label>
                <Input id="addressLine" {...form.register('addressLine')} />
                {form.formState.errors.addressLine && (
                  <p className="text-sm text-red-600">
                    {form.formState.errors.addressLine.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="city">Città</Label>
                <Input id="city" {...form.register('city')} />
                {form.formState.errors.city && (
                  <p className="text-sm text-red-600">{form.formState.errors.city.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="province">Provincia</Label>
                <Input id="province" {...form.register('province')} />
                {form.formState.errors.province && (
                  <p className="text-sm text-red-600">{form.formState.errors.province.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="postalCode">CAP</Label>
                <Input id="postalCode" {...form.register('postalCode')} />
                {form.formState.errors.postalCode && (
                  <p className="text-sm text-red-600">{form.formState.errors.postalCode.message}</p>
                )}
              </div>

              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Salvataggio...' : 'Salva modifiche'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ── Users section ─────────────────────────────────────────────────── */}
        <Card className="mt-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Utenti</CardTitle>
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                Invita utente
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {usersError ? (
              <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
                Errore nel caricamento degli utenti.
              </div>
            ) : usersLoading || !usersData ? (
              <p className="text-muted-foreground">Caricamento utenti…</p>
            ) : usersData.users.length === 0 ? (
              <p className="text-muted-foreground">Nessun utente.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Ruolo</TableHead>
                    <TableHead>Stato</TableHead>
                    <TableHead>Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usersData.users.map((user) => {
                    // See BR-220: deletedAt marks a soft-deleted user; status 'inactive'
                    // marks a disabled-but-not-deleted user. Both render as "Disattivato".
                    const isDisabled = user.deletedAt != null || user.status === 'inactive';
                    const fullName = `${user.firstName} ${user.lastName}`;
                    const newRole: 'mechanic' | 'super_admin' =
                      user.role === 'super_admin' ? 'mechanic' : 'super_admin';

                    return (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">{fullName}</TableCell>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>
                          <Badge variant={user.role === 'super_admin' ? 'default' : 'secondary'}>
                            {user.role === 'super_admin' ? 'Amministratore' : 'Meccanico'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={isDisabled ? 'destructive' : 'default'}>
                            {isDisabled ? 'Disattivato' : 'Attivo'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2 flex-wrap">
                            {/* Disabilita — shown only for active users (BR-220) */}
                            {!isDisabled && (
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={
                                  disableMutation.isPending && disableMutation.variables === user.id
                                }
                                onClick={() =>
                                  setDisableTarget({ userId: user.id, name: fullName })
                                }
                              >
                                Disabilita
                              </Button>
                            )}
                            {/* Riattiva — shown when status=inactive or user is soft-deleted */}
                            {isDisabled && (
                              <Button
                                variant="default"
                                size="sm"
                                disabled={
                                  reactivateUserMutation.isPending &&
                                  reactivateUserMutation.variables === user.id
                                }
                                onClick={() =>
                                  setReactivateTarget({ userId: user.id, name: fullName })
                                }
                              >
                                Riattiva
                              </Button>
                            )}
                            {/* Role toggle — only for active non-deleted users.
                                Soft-deleted (deletedAt != null) or disabled (status=inactive)
                                users are excluded: the backend lookup filters deletedAt:null
                                and would return 404 user.not_found for deleted rows. */}
                            {!isDisabled && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  roleMutation.isPending &&
                                  roleMutation.variables?.userId === user.id
                                }
                                onClick={() =>
                                  setRoleTarget({ userId: user.id, name: fullName, newRole })
                                }
                              >
                                {user.role === 'super_admin'
                                  ? 'Rendi meccanico'
                                  : 'Rendi amministratore'}
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
          </CardContent>
        </Card>

        {/* ── Metrics section ───────────────────────────────────────────────── */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Metriche</CardTitle>
          </CardHeader>
          <CardContent>
            {metricsError ? (
              <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
                Errore nel caricamento delle metriche.
              </div>
            ) : metricsLoading || !metricsData ? (
              <p className="text-muted-foreground">Caricamento metriche…</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <StatCard
                  label="Interventi"
                  value={metricsData.interventions.total}
                  hint={`${metricsData.interventions.last30d} ultimi 30 giorni`}
                />
                <StatCard
                  label="Ultimo intervento"
                  value={
                    metricsData.interventions.lastAt
                      ? new Date(metricsData.interventions.lastAt).toLocaleDateString('it-IT')
                      : '—'
                  }
                />
                <StatCard label="Utenti" value={metricsData.usersTotal} />
                <StatCard label="Veicoli" value={metricsData.vehiclesTotal} />
                <StatCard label="Clienti" value={metricsData.customersTotal} />
                <StatCard label="Scadenze aperte" value={metricsData.openDeadlines} />
                <StatCard label="Inviti pendenti" value={metricsData.pendingInvitations} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Disable user confirm dialog ────────────────────────────────────────── */}
      <AlertDialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disabilita utente</AlertDialogTitle>
            <AlertDialogDescription>
              Disabilitare {disableTarget?.name}? L&apos;utente non potrà più accedere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disableMutation.isPending}>Annulla</AlertDialogCancel>
            <AlertDialogAction
              disabled={disableMutation.isPending}
              onClick={(e) => {
                // Prevent the AlertDialog from closing before the mutation resolves;
                // onSuccess closes it explicitly via setDisableTarget(null).
                e.preventDefault();
                if (disableTarget) disableMutation.mutate(disableTarget.userId);
              }}
            >
              Disabilita
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reactivate user confirm dialog ────────────────────────────────────── */}
      <AlertDialog
        open={reactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReactivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Riattiva utente</AlertDialogTitle>
            <AlertDialogDescription>
              Riattivare {reactivateTarget?.name}? L&apos;utente potrà nuovamente accedere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reactivateUserMutation.isPending}>
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={reactivateUserMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (reactivateTarget) reactivateUserMutation.mutate(reactivateTarget.userId);
              }}
            >
              Riattiva
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Change role confirm dialog ─────────────────────────────────────────── */}
      <AlertDialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cambia ruolo</AlertDialogTitle>
            <AlertDialogDescription>
              Cambiare il ruolo di {roleTarget?.name} a{' '}
              {roleTarget?.newRole === 'super_admin' ? 'Amministratore' : 'Meccanico'}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={roleMutation.isPending}>Annulla</AlertDialogCancel>
            <AlertDialogAction
              disabled={roleMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (roleTarget)
                  roleMutation.mutate({
                    userId: roleTarget.userId,
                    newRole: roleTarget.newRole,
                  });
              }}
            >
              Conferma
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Invite user dialog ────────────────────────────────────────────────── */}
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!open) {
            setInviteOpen(false);
            inviteForm.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invita utente</DialogTitle>
            <DialogDescription>
              Invia un link di accesso all&apos;utente per questa officina.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={inviteForm.handleSubmit(onInviteSubmit)} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" type="email" {...inviteForm.register('email')} />
              {inviteForm.formState.errors.email && (
                <p className="text-sm text-red-600">{inviteForm.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-firstName">Nome</Label>
              <Input id="invite-firstName" {...inviteForm.register('firstName')} />
              {inviteForm.formState.errors.firstName && (
                <p className="text-sm text-red-600">
                  {inviteForm.formState.errors.firstName.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-lastName">Cognome</Label>
              <Input id="invite-lastName" {...inviteForm.register('lastName')} />
              {inviteForm.formState.errors.lastName && (
                <p className="text-sm text-red-600">
                  {inviteForm.formState.errors.lastName.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              {/* Native <select> avoids the shadcn select install and the literal @/ dir risk.
                  See [[feedback_shadcn_cli_literal_alias_path]]. */}
              <Label htmlFor="invite-role">Ruolo</Label>
              <select
                id="invite-role"
                {...inviteForm.register('role')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="mechanic">Meccanico</option>
                <option value="super_admin">Amministratore</option>
              </select>
              {inviteForm.formState.errors.role && (
                <p className="text-sm text-red-600">{inviteForm.formState.errors.role.message}</p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setInviteOpen(false);
                  inviteForm.reset();
                }}
              >
                Annulla
              </Button>
              <Button type="submit" disabled={inviteMutation.isPending}>
                {inviteMutation.isPending ? 'Invio...' : 'Invita'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Invite result dialog ─────────────────────────────────────────────── */}
      {/* Mirrors the regenerate-invitation result dialog in TenantList.tsx exactly. */}
      <Dialog
        open={inviteResult !== null}
        onOpenChange={(open) => {
          if (!open) setInviteResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invito inviato</DialogTitle>
            <DialogDescription>
              {inviteResult?.emailSent
                ? `Email inviata a ${inviteResult.email}.`
                : 'Email non inviata — copia il link e invialo manualmente.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input readOnly value={inviteResult?.magicLinkUrl ?? ''} aria-label="Magic link" />
            <Button
              variant="outline"
              onClick={() => {
                if (inviteResult) {
                  // Guard: navigator.clipboard is undefined in non-secure contexts
                  // (HTTP, iframes without clipboard-write permission). Accessing a
                  // property on undefined would throw synchronously before .catch() runs.
                  if (!navigator.clipboard) {
                    toast.error('Impossibile copiare. Selezionalo e copialo manualmente.');
                    return;
                  }
                  // In a secure context, a rejected promise means the user denied the
                  // clipboard-write permission — the readonly input stays as fallback.
                  navigator.clipboard
                    .writeText(inviteResult.magicLinkUrl)
                    .then(() => toast.success('Link copiato negli appunti.'))
                    .catch(() =>
                      toast.error('Impossibile copiare. Selezionalo e copialo manualmente.'),
                    );
                }
              }}
            >
              Copia
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

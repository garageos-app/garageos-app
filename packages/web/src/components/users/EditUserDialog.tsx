// EditUserDialog — F-OFF-004 Super Admin edit user flow.
//
// Three action sections (no tabs — simpler layout):
//   1. Change Role   — BR-204: mechanic requires a locationId.
//   2. Change Location — set/reassign a user's location.
//   3. Deactivate    — two-step confirm before calling useDeleteUser.
//
// Inline error handling:
//   409 user.last_super_admin  → red banner (BR-203).
//   422 user.location_required_for_mechanic → field-level error at locationId.
//   Other ApiError → form-level banner.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import { type AdminUser, useUpdateUser, useDeleteUser, useLocations } from '@/queries/users-admin';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ChangeRoleSchema = z
  .object({
    role: z.enum(['super_admin', 'mechanic'], {
      error: 'Ruolo obbligatorio',
    }),
    locationId: z.string().uuid().nullable(),
  })
  // BR-204: mechanic requires a location assignment.
  .refine((data) => !(data.role === 'mechanic' && !data.locationId), {
    message: 'La sede è obbligatoria per il ruolo Meccanico',
    path: ['locationId'],
  });

const ChangeLocationSchema = z.object({
  locationId: z.string().uuid({ message: 'Seleziona una sede valida' }),
});

type ChangeRoleValues = z.infer<typeof ChangeRoleSchema>;
type ChangeLocationValues = z.infer<typeof ChangeLocationSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EditUserDialog({ user, open, onOpenChange }: Props) {
  const updateMut = useUpdateUser();
  const deleteMut = useDeleteUser();
  const locationsQ = useLocations();

  // Deactivate two-step confirm state.
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Change-Role section.
  const [roleError, setRoleError] = useState<string | null>(null);
  const roleForm = useForm<ChangeRoleValues>({
    resolver: zodResolver(ChangeRoleSchema),
    defaultValues: {
      role: user.role,
      locationId: user.locationId,
    },
  });
  const selectedRole = roleForm.watch('role');

  // Change-Location section.
  const [locationError, setLocationError] = useState<string | null>(null);
  const locationForm = useForm<ChangeLocationValues>({
    resolver: zodResolver(ChangeLocationSchema),
    defaultValues: {
      locationId: user.locationId ?? '',
    },
  });

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      roleForm.reset({ role: user.role, locationId: user.locationId });
      locationForm.reset({ locationId: user.locationId ?? '' });
      setRoleError(null);
      setLocationError(null);
      setConfirmDeactivate(false);
      setDeactivateError(null);
    }
    onOpenChange(nextOpen);
  }

  // ── Change Role submit ──────────────────────────────────────────────────────

  async function onRoleSubmit(values: ChangeRoleValues) {
    setRoleError(null);
    try {
      await updateMut.mutateAsync({
        id: user.id,
        body: {
          role: values.role,
          // Only send locationId when switching to mechanic — avoids clearing
          // an existing location when just updating the role to super_admin.
          ...(values.role === 'mechanic' ? { locationId: values.locationId } : {}),
        },
      });
      // useUpdateUser.onSuccess fires toast.success('Utente aggiornato').
      handleClose(false);
    } catch (err) {
      if (err instanceof ApiError) {
        // BR-203: last super admin cannot be demoted.
        if (err.code === 'user.last_super_admin') {
          setRoleError(
            err.message ||
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
          );
          return;
        }
        // BR-204 server defensive surface.
        if (err.code === 'user.location_required_for_mechanic') {
          roleForm.setError('locationId', {
            type: 'server',
            message: 'La sede è obbligatoria per il ruolo Meccanico',
          });
          return;
        }
        setRoleError(translateError(err.code, err.message));
      } else {
        setRoleError('Errore imprevisto, riprova.');
      }
    }
  }

  // ── Change Location submit ──────────────────────────────────────────────────

  async function onLocationSubmit(values: ChangeLocationValues) {
    setLocationError(null);
    try {
      await updateMut.mutateAsync({
        id: user.id,
        body: { locationId: values.locationId },
      });
      handleClose(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setLocationError(translateError(err.code, err.message));
      } else {
        setLocationError('Errore imprevisto, riprova.');
      }
    }
  }

  // ── Deactivate ──────────────────────────────────────────────────────────────

  async function handleDeactivate() {
    setDeactivateError(null);
    try {
      await deleteMut.mutateAsync(user.id);
      // useDeleteUser.onSuccess fires toast.success('Utente rimosso').
      handleClose(false);
    } catch (err) {
      if (err instanceof ApiError) {
        // BR-203 can also surface here if deleting the last super admin.
        if (err.code === 'user.last_super_admin') {
          setDeactivateError(
            err.message ||
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
          );
        } else {
          setDeactivateError(translateError(err.code, err.message));
        }
      } else {
        setDeactivateError('Errore imprevisto, riprova.');
      }
      setConfirmDeactivate(false);
    }
  }

  const locations = locationsQ.data?.locations ?? [];
  const roleErrors = roleForm.formState.errors;
  const locationErrors = locationForm.formState.errors;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Modifica utente — {user.firstName} {user.lastName}
          </DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* ── Section 1: Change Role ──────────────────────────────────────── */}
          <section>
            <h3 className="font-medium mb-3">Cambia ruolo</h3>
            <form onSubmit={roleForm.handleSubmit(onRoleSubmit)} noValidate className="space-y-3">
              {roleError && (
                <div
                  className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
                  role="alert"
                  data-testid="role-error"
                >
                  {roleError}
                </div>
              )}

              <div>
                <Label htmlFor="edit-role">Ruolo</Label>
                <Select
                  value={selectedRole ?? ''}
                  onValueChange={(v) =>
                    roleForm.setValue('role', v as ChangeRoleValues['role'], {
                      shouldValidate: true,
                    })
                  }
                >
                  <SelectTrigger id="edit-role">
                    <SelectValue placeholder="Seleziona ruolo…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="super_admin">Super Admin</SelectItem>
                    <SelectItem value="mechanic">Meccanico</SelectItem>
                  </SelectContent>
                </Select>
                {roleErrors.role && (
                  <p className="text-sm text-red-600 mt-1">{roleErrors.role.message}</p>
                )}
              </div>

              {/* Location selector only shown when role is mechanic — BR-204. */}
              {selectedRole === 'mechanic' && (
                <div>
                  <Label htmlFor="edit-role-location">Sede *</Label>
                  <Select
                    value={roleForm.watch('locationId') ?? ''}
                    onValueChange={(v) =>
                      roleForm.setValue('locationId', v || null, { shouldValidate: true })
                    }
                  >
                    <SelectTrigger id="edit-role-location">
                      <SelectValue placeholder="Seleziona sede…" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((loc) => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.name}
                          {loc.city ? ` — ${loc.city}` : ''}
                          {loc.isPrimary ? ' (principale)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {roleErrors.locationId && (
                    <p className="text-sm text-red-600 mt-1">{roleErrors.locationId.message}</p>
                  )}
                </div>
              )}

              <Button type="submit" size="sm" disabled={roleForm.formState.isSubmitting}>
                {roleForm.formState.isSubmitting ? 'Salvataggio…' : 'Salva ruolo'}
              </Button>
            </form>
          </section>

          <hr />

          {/* ── Section 2: Change Location ─────────────────────────────────── */}
          <section>
            <h3 className="font-medium mb-3">Cambia sede</h3>
            <form
              onSubmit={locationForm.handleSubmit(onLocationSubmit)}
              noValidate
              className="space-y-3"
            >
              {locationError && (
                <div
                  className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
                  role="alert"
                  data-testid="location-error"
                >
                  {locationError}
                </div>
              )}

              <div>
                <Label htmlFor="edit-location">Sede</Label>
                <Select
                  value={locationForm.watch('locationId') ?? ''}
                  onValueChange={(v) =>
                    locationForm.setValue('locationId', v, { shouldValidate: true })
                  }
                >
                  <SelectTrigger id="edit-location">
                    <SelectValue placeholder="Seleziona sede…" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>
                        {loc.name}
                        {loc.city ? ` — ${loc.city}` : ''}
                        {loc.isPrimary ? ' (principale)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {locationErrors.locationId && (
                  <p className="text-sm text-red-600 mt-1">{locationErrors.locationId.message}</p>
                )}
              </div>

              <Button type="submit" size="sm" disabled={locationForm.formState.isSubmitting}>
                {locationForm.formState.isSubmitting ? 'Salvataggio…' : 'Salva sede'}
              </Button>
            </form>
          </section>

          <hr />

          {/* ── Section 3: Deactivate ───────────────────────────────────────── */}
          {/* Hide the deactivate action entirely when the user is already
              inactive — the backend filters `deletedAt: null` so clicking
              would yield a confusing 404 user.not_found. Reactivation is
              a separate (deferred) decision; see PR description. */}
          {user.status === 'active' && (
            <section>
              <h3 className="font-medium mb-3">Disattiva utente</h3>

              {deactivateError && (
                <div
                  className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm mb-3"
                  role="alert"
                  data-testid="deactivate-error"
                >
                  {deactivateError}
                </div>
              )}

              {!confirmDeactivate ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDeactivate(true)}
                  data-testid="deactivate-button"
                >
                  Disattiva utente
                </Button>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Sei sicuro? L&apos;utente perderà immediatamente l&apos;accesso.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleteMut.isPending}
                      onClick={() => void handleDeactivate()}
                      data-testid="deactivate-confirm-button"
                    >
                      {deleteMut.isPending ? 'Disattivazione…' : 'Conferma disattivazione'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={deleteMut.isPending}
                      onClick={() => setConfirmDeactivate(false)}
                    >
                      Annulla
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {user.status === 'inactive' && (
            <section data-testid="inactive-notice">
              <h3 className="font-medium mb-2">Utente disattivato</h3>
              <p className="text-sm text-muted-foreground">
                Questo utente è disattivato. La riattivazione non è ancora supportata.
              </p>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Chiudi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

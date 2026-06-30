// EditUserDialog — F-OFF-004 Super Admin edit user flow.
//
// Two action sections (no tabs — simpler layout):
//   1. Change Role
//   2. Deactivate — two-step confirm before calling useDeleteUser.
//
// Inline error handling:
//   409 user.last_super_admin  → red banner (BR-203).
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
import { type AdminUser, useUpdateUser, useDeleteUser } from '@/queries/users-admin';
import { ReactivateSection } from './ReactivateSection';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ChangeRoleSchema = z.object({
  role: z.enum(['super_admin', 'mechanic'], {
    error: 'Ruolo obbligatorio',
  }),
});

type ChangeRoleValues = z.infer<typeof ChangeRoleSchema>;

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

  // Deactivate two-step confirm state.
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Change-Role section.
  const [roleError, setRoleError] = useState<string | null>(null);
  const roleForm = useForm<ChangeRoleValues>({
    resolver: zodResolver(ChangeRoleSchema),
    defaultValues: {
      role: user.role,
    },
  });
  const selectedRole = roleForm.watch('role');

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      roleForm.reset({ role: user.role });
      setRoleError(null);
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
        setRoleError(translateError(err.code, err.message));
      } else {
        setRoleError('Errore imprevisto, riprova.');
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

  const roleErrors = roleForm.formState.errors;

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
          {user.status === 'inactive' ? (
            <ReactivateSection user={user} onSuccess={() => handleClose(false)} />
          ) : (
            <>
              {/* ── Section 1: Change Role ──────────────────────────────────────── */}
              <section>
                <h3 className="font-medium mb-3">Cambia ruolo</h3>
                <form
                  onSubmit={roleForm.handleSubmit(onRoleSubmit)}
                  noValidate
                  className="space-y-3"
                >
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

                  <Button type="submit" size="sm" disabled={roleForm.formState.isSubmitting}>
                    {roleForm.formState.isSubmitting ? 'Salvataggio…' : 'Salva ruolo'}
                  </Button>
                </form>
              </section>

              <hr />

              {/* ── Section 2: Deactivate ───────────────────────────────────────── */}
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
            </>
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

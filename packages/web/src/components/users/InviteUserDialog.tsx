// InviteUserDialog — F-OFF-004 Super Admin invite flow.
//
// Mirrors EditInterventionDialog.tsx for the shadcn Dialog + react-hook-form
// + zod-resolver pattern. Key rule enforced here:
//   BR-204: mechanic role requires a locationId (Zod .refine + server 422
//           defensive surface at the locationId field).

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { useInviteUser, useLocations } from '@/queries/users-admin';

// ─── Zod schema ───────────────────────────────────────────────────────────────

const InviteUserFormSchema = z
  .object({
    email: z
      .string()
      .min(1, 'Email obbligatoria')
      .email('Email non valida')
      .max(255, 'Email troppo lunga (max 255 caratteri)'),
    firstName: z
      .string()
      .min(1, 'Nome obbligatorio')
      .max(100, 'Nome troppo lungo (max 100 caratteri)'),
    lastName: z
      .string()
      .min(1, 'Cognome obbligatorio')
      .max(100, 'Cognome troppo lungo (max 100 caratteri)'),
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

type InviteUserFormValues = z.infer<typeof InviteUserFormSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InviteUserDialog({ open, onOpenChange }: Props) {
  const mutation = useInviteUser();
  const locationsQ = useLocations();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteUserFormValues>({
    resolver: zodResolver(InviteUserFormSchema),
    defaultValues: {
      email: '',
      firstName: '',
      lastName: '',
      role: undefined,
      locationId: null,
    },
  });

  const selectedRole = watch('role');

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      reset();
      setFormError(null);
    }
    onOpenChange(nextOpen);
  }

  async function onSubmit(values: InviteUserFormValues) {
    setFormError(null);
    try {
      await mutation.mutateAsync({
        email: values.email,
        firstName: values.firstName,
        lastName: values.lastName,
        role: values.role,
        locationId: values.locationId,
      });
      // useInviteUser's onSuccess already fires toast.success('Invito inviato').
      // Show a personalised message with the email to confirm the recipient.
      toast.success(`Invito inviato a ${values.email}`);
      handleClose(false);
    } catch (err) {
      if (err instanceof ApiError) {
        // Defensive: surface server 422 location_required at the field level
        // in case client-side BR-204 check is bypassed.
        if (err.code === 'user.location_required_for_mechanic') {
          setError('locationId', {
            type: 'server',
            message: 'La sede è obbligatoria per il ruolo Meccanico',
          });
          return;
        }
        setFormError(translateError(err.code, err.message));
      } else {
        setFormError('Errore imprevisto, riprova.');
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invita utente</DialogTitle>
          <DialogDescription>
            Invia un invito via email per aggiungere un nuovo utente al tuo account.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          {formError && (
            <div
              className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
              role="alert"
            >
              {formError}
            </div>
          )}

          <div>
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" autoComplete="off" {...register('email')} />
            {errors.email && <p className="text-sm text-red-600 mt-1">{errors.email.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="invite-firstName">Nome</Label>
              <Input id="invite-firstName" {...register('firstName')} />
              {errors.firstName && (
                <p className="text-sm text-red-600 mt-1">{errors.firstName.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="invite-lastName">Cognome</Label>
              <Input id="invite-lastName" {...register('lastName')} />
              {errors.lastName && (
                <p className="text-sm text-red-600 mt-1">{errors.lastName.message}</p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="invite-role">Ruolo</Label>
            <Select
              value={selectedRole ?? ''}
              onValueChange={(v) =>
                setValue('role', v as InviteUserFormValues['role'], { shouldValidate: true })
              }
            >
              <SelectTrigger id="invite-role">
                <SelectValue placeholder="Seleziona ruolo…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="super_admin">Super Admin</SelectItem>
                <SelectItem value="mechanic">Meccanico</SelectItem>
              </SelectContent>
            </Select>
            {errors.role && <p className="text-sm text-red-600 mt-1">{errors.role.message}</p>}
          </div>

          <div>
            <Label htmlFor="invite-location">
              Sede{selectedRole === 'mechanic' ? ' *' : ' (opzionale)'}
            </Label>
            <Select
              value={watch('locationId') ?? ''}
              onValueChange={(v) => setValue('locationId', v || null, { shouldValidate: true })}
            >
              <SelectTrigger id="invite-location">
                <SelectValue placeholder="Seleziona sede…" />
              </SelectTrigger>
              <SelectContent>
                {(locationsQ.data?.locations ?? []).map((loc) => (
                  <SelectItem key={loc.id} value={loc.id}>
                    {loc.name}
                    {loc.city ? ` — ${loc.city}` : ''}
                    {loc.isPrimary ? ' (principale)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.locationId && (
              <p className="text-sm text-red-600 mt-1">{errors.locationId.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={isSubmitting}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Invio…' : 'Invia invito'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// LocationFormDialog — F-OFF-003 PR2 create/edit a tenant location.
// `location` null → create mode (POST); non-null → edit mode (PATCH all
// editable fields). Promotion-to-primary and deactivation are row actions
// in LocationManagement, not part of this form.

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

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
import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import {
  locationFormSchema,
  type LocationFormValues,
  type LocationFormParsed,
} from '@/lib/validators/location';
import { useCreateLocation, useUpdateLocation, type TenantLocation } from '@/queries/locations';

interface Props {
  location: TenantLocation | null; // null = create
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function toDefaults(loc: TenantLocation | null): LocationFormValues {
  return {
    name: loc?.name ?? '',
    addressLine: loc?.addressLine ?? '',
    city: loc?.city ?? '',
    province: loc?.province ?? '',
    postalCode: loc?.postalCode ?? '',
    country: loc?.country ?? 'IT',
    phone: loc?.phone ?? '',
    email: loc?.email ?? '',
  };
}

export function LocationFormDialog({ location, open, onOpenChange }: Props) {
  const createMut = useCreateLocation();
  const updateMut = useUpdateLocation();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LocationFormValues, unknown, LocationFormParsed>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: toDefaults(location),
  });

  // Re-seed the form whenever the dialog opens for a different location.
  useEffect(() => {
    if (open) {
      form.reset(toDefaults(location));
      setFormError(null);
    }
  }, [open, location, form]);

  const errors = form.formState.errors;
  const isEdit = location !== null;

  async function onSubmit(values: LocationFormParsed) {
    setFormError(null);
    try {
      if (location) {
        await updateMut.mutateAsync({ id: location.id, body: values });
      } else {
        await createMut.mutateAsync(values);
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setFormError(translateError(err.code, err.message));
      else setFormError('Errore imprevisto, riprova.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Modifica sede' : 'Aggiungi sede'}</DialogTitle>
          <DialogDescription>
            {isEdit ? location.name : 'Crea una nuova sede per la tua officina.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-3">
          {formError && (
            <div
              className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 rounded-md p-3 text-sm"
              role="alert"
              data-testid="location-form-error"
            >
              {formError}
            </div>
          )}

          <div>
            <Label htmlFor="loc-name">Nome *</Label>
            <Input id="loc-name" {...form.register('name')} />
            {errors.name && <p className="text-sm text-red-600 mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="loc-address">Indirizzo *</Label>
            <Input id="loc-address" {...form.register('addressLine')} />
            {errors.addressLine && (
              <p className="text-sm text-red-600 mt-1">{errors.addressLine.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="loc-city">Città *</Label>
              <Input id="loc-city" {...form.register('city')} />
              {errors.city && <p className="text-sm text-red-600 mt-1">{errors.city.message}</p>}
            </div>
            <div>
              <Label htmlFor="loc-province">Provincia *</Label>
              <Input id="loc-province" maxLength={2} {...form.register('province')} />
              {errors.province && (
                <p className="text-sm text-red-600 mt-1">{errors.province.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="loc-cap">CAP *</Label>
              <Input id="loc-cap" {...form.register('postalCode')} />
              {errors.postalCode && (
                <p className="text-sm text-red-600 mt-1">{errors.postalCode.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="loc-country">Paese</Label>
              <Input id="loc-country" maxLength={2} {...form.register('country')} />
              {errors.country && (
                <p className="text-sm text-red-600 mt-1">{errors.country.message}</p>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="loc-phone">Telefono</Label>
            <Input id="loc-phone" {...form.register('phone')} />
            {errors.phone && <p className="text-sm text-red-600 mt-1">{errors.phone.message}</p>}
          </div>
          <div>
            <Label htmlFor="loc-email">Email</Label>
            <Input id="loc-email" {...form.register('email')} />
            {errors.email && <p className="text-sm text-red-600 mt-1">{errors.email.message}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Salvataggio…' : isEdit ? 'Salva' : 'Crea sede'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

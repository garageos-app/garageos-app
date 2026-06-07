// F-OFF-201 standalone customer creation. Mirrors InviteUserDialog
// (shadcn Dialog + react-hook-form + zodResolver + sonner toast).
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
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
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import { useCreateCustomer } from '@/queries/customersCreate';
import type { CustomerCreateBody } from '@/queries/types';

const FormSchema = z
  .object({
    firstName: z.string().min(1, 'Nome obbligatorio').max(100, 'Nome troppo lungo'),
    lastName: z.string().min(1, 'Cognome obbligatorio').max(100, 'Cognome troppo lungo'),
    email: z.string().min(1, 'Email obbligatoria').email('Email non valida').max(255),
    phone: z.string().max(30).optional(),
    taxCode: z.string().max(20).optional(),
    addressLine: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    province: z.string().max(2).optional(),
    postalCode: z.string().max(10).optional(),
    isBusiness: z.boolean(),
    businessName: z.string().max(200).optional(),
    vatNumber: z.string().max(20).optional(),
  })
  .refine((d) => !(d.isBusiness && !d.businessName?.trim()), {
    message: 'Ragione sociale obbligatoria',
    path: ['businessName'],
  });

type FormValues = z.infer<typeof FormSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Drop empty-string optionals so the API stores null, not "".
function toBody(v: FormValues): CustomerCreateBody {
  const opt = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
  return {
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim(),
    email: v.email.trim(),
    isBusiness: v.isBusiness,
    ...(opt(v.phone) ? { phone: opt(v.phone) } : {}),
    ...(opt(v.taxCode) ? { taxCode: opt(v.taxCode) } : {}),
    ...(opt(v.addressLine) ? { addressLine: opt(v.addressLine) } : {}),
    ...(opt(v.city) ? { city: opt(v.city) } : {}),
    ...(opt(v.province) ? { province: opt(v.province) } : {}),
    ...(opt(v.postalCode) ? { postalCode: opt(v.postalCode) } : {}),
    ...(v.isBusiness && opt(v.businessName) ? { businessName: opt(v.businessName) } : {}),
    ...(opt(v.vatNumber) ? { vatNumber: opt(v.vatNumber) } : {}),
  };
}

export function CreateCustomerDialog({ open, onOpenChange }: Props) {
  const mutation = useCreateCustomer();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { firstName: '', lastName: '', email: '', isBusiness: false },
  });

  const isBusiness = watch('isBusiness');

  function handleClose(next: boolean) {
    if (!next) {
      reset();
      setFormError(null);
    }
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    setFormError(null);
    try {
      const result = await mutation.mutateAsync(toBody(values));
      toast.success(
        result.created ? 'Cliente creato' : 'Cliente già esistente, collegato alla tua officina',
      );
      handleClose(false);
      navigate(`/customers/${result.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
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
          <DialogTitle>Nuovo cliente</DialogTitle>
          <DialogDescription>Aggiungi un cliente alla tua anagrafica.</DialogDescription>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cc-firstName">Nome</Label>
              <Input id="cc-firstName" {...register('firstName')} />
              {errors.firstName && (
                <p className="text-sm text-red-600 mt-1">{errors.firstName.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="cc-lastName">Cognome</Label>
              <Input id="cc-lastName" {...register('lastName')} />
              {errors.lastName && (
                <p className="text-sm text-red-600 mt-1">{errors.lastName.message}</p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="cc-email">Email</Label>
            <Input id="cc-email" type="email" autoComplete="off" {...register('email')} />
            {errors.email && <p className="text-sm text-red-600 mt-1">{errors.email.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cc-phone">Telefono (opzionale)</Label>
              <Input id="cc-phone" {...register('phone')} />
            </div>
            <div>
              <Label htmlFor="cc-taxCode">Codice fiscale (opzionale)</Label>
              <Input id="cc-taxCode" {...register('taxCode')} />
            </div>
          </div>

          <div>
            <Label htmlFor="cc-addressLine">Indirizzo (opzionale)</Label>
            <Input id="cc-addressLine" {...register('addressLine')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="cc-city">Città</Label>
              <Input id="cc-city" {...register('city')} />
            </div>
            <div>
              <Label htmlFor="cc-province">Prov.</Label>
              <Input id="cc-province" maxLength={2} {...register('province')} />
            </div>
            <div>
              <Label htmlFor="cc-postalCode">CAP</Label>
              <Input id="cc-postalCode" {...register('postalCode')} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="cc-isBusiness"
              checked={isBusiness}
              onCheckedChange={(v) => setValue('isBusiness', v, { shouldValidate: true })}
              aria-label="Cliente aziendale"
            />
            <Label htmlFor="cc-isBusiness">Cliente aziendale</Label>
          </div>

          {isBusiness && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cc-businessName">Ragione sociale</Label>
                <Input id="cc-businessName" {...register('businessName')} />
                {errors.businessName && (
                  <p className="text-sm text-red-600 mt-1">{errors.businessName.message}</p>
                )}
              </div>
              <div>
                <Label htmlFor="cc-vatNumber">P.IVA (opzionale)</Label>
                <Input id="cc-vatNumber" {...register('vatNumber')} />
              </div>
            </div>
          )}

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
              {isSubmitting ? 'Creazione…' : 'Crea cliente'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTenantUpdate, type TenantUpdateBody } from '@/queries/tenantUpdate';
import type { TenantMeDto } from '@/queries/tenantMe';
import {
  tenantFormSchema,
  type TenantFormValues,
  type TenantFormParsed,
} from '@/lib/validators/tenant';

interface Props {
  tenant: TenantMeDto;
  // Lifts the form API to the parent Settings page so it can read
  // formState.isDirty for the cross-tab dirty AlertDialog.
  formRef?: (form: UseFormReturn<TenantFormValues, unknown, TenantFormParsed>) => void;
}

// Editable keys for the diff builder. Mirrors the bodySchema fields
// in packages/api/src/routes/v1/tenants-update.ts.
const EDITABLE_KEYS = [
  'businessName',
  'addressLine',
  'city',
  'province',
  'postalCode',
  'phone',
  'email',
] as const;

function buildDiff(
  parsed: TenantFormParsed,
  dirty: Partial<Record<keyof TenantFormValues, boolean | undefined>>,
): TenantUpdateBody {
  const diff: TenantUpdateBody = {};
  for (const key of EDITABLE_KEYS) {
    if (dirty[key]) {
      (diff as Record<string, unknown>)[key] = parsed[key];
    }
  }
  return diff;
}

export function TenantForm({ tenant, formRef }: Props) {
  const form = useForm<TenantFormValues, unknown, TenantFormParsed>({
    resolver: zodResolver(tenantFormSchema),
    defaultValues: {
      businessName: tenant.businessName,
      addressLine: tenant.addressLine ?? '',
      city: tenant.city ?? '',
      province: tenant.province ?? '',
      postalCode: tenant.postalCode ?? '',
      phone: tenant.phone ?? '',
      email: tenant.email,
    },
  });

  useEffect(() => {
    formRef?.(form as UseFormReturn<TenantFormValues, unknown, TenantFormParsed>);
  }, [form, formRef]);

  const mutation = useTenantUpdate();

  async function onSubmit(values: TenantFormParsed) {
    const diff = buildDiff(values, form.formState.dirtyFields);
    if (Object.keys(diff).length === 0) return;
    try {
      const updated = await mutation.mutateAsync(diff);
      form.reset({
        businessName: updated.businessName,
        addressLine: updated.addressLine ?? '',
        city: updated.city ?? '',
        province: updated.province ?? '',
        postalCode: updated.postalCode ?? '',
        phone: updated.phone ?? '',
        email: updated.email,
      });
    } catch {
      // toast handled by mutation onError
    }
  }

  const { isDirty } = form.formState;

  return (
    <div className="space-y-4 max-w-xl">
      {tenant.vatNumber && (
        <div className="rounded-md bg-slate-50 dark:bg-slate-900 p-3 text-sm">
          <span className="text-slate-500">P. IVA: </span>
          <span className="font-mono">{tenant.vatNumber}</span>
        </div>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="businessName">Ragione sociale</Label>
          <Input id="businessName" {...form.register('businessName')} />
          {form.formState.errors.businessName && (
            <p className="text-sm text-red-600">{form.formState.errors.businessName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="addressLine">Indirizzo</Label>
          <Input id="addressLine" {...form.register('addressLine')} />
          {form.formState.errors.addressLine && (
            <p className="text-sm text-red-600">{form.formState.errors.addressLine.message}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-2">
            <Label htmlFor="city">Città</Label>
            <Input id="city" {...form.register('city')} />
            {form.formState.errors.city && (
              <p className="text-sm text-red-600">{form.formState.errors.city.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="province">Provincia</Label>
            <Input id="province" maxLength={2} {...form.register('province')} />
            {form.formState.errors.province && (
              <p className="text-sm text-red-600">{form.formState.errors.province.message}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="postalCode">CAP</Label>
          <Input id="postalCode" maxLength={5} {...form.register('postalCode')} />
          {form.formState.errors.postalCode && (
            <p className="text-sm text-red-600">{form.formState.errors.postalCode.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenantPhone">Telefono</Label>
          <Input id="tenantPhone" {...form.register('phone')} placeholder="+39 ..." />
          {form.formState.errors.phone && (
            <p className="text-sm text-red-600">{form.formState.errors.phone.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenantEmail">Email</Label>
          <Input id="tenantEmail" type="email" {...form.register('email')} />
          {form.formState.errors.email && (
            <p className="text-sm text-red-600">{form.formState.errors.email.message}</p>
          )}
        </div>

        <Button type="submit" disabled={!isDirty || mutation.isPending}>
          {mutation.isPending ? 'Salvataggio...' : 'Salva'}
        </Button>
      </form>
    </div>
  );
}

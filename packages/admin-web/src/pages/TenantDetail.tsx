import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useApiFetch, ApiError } from '@/lib/api-client';
import { STATUS_BADGE } from '@/lib/tenant-status';
import { ACTION_ERROR_MESSAGES, GENERIC_ACTION_ERROR } from '@/lib/tenant-actions';
import type { TenantProfile } from '@/lib/tenant-detail-types';
import {
  tenantProfileSchema,
  type TenantProfileValues,
  type TenantProfileParsed,
} from '@/lib/validators/tenant-profile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function TenantDetail() {
  // id is always defined when this component is mounted via <Route path="/officine/:id" />.
  const { id } = useParams<{ id: string }>();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

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
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiError
          ? (ACTION_ERROR_MESSAGES[err.code] ?? GENERIC_ACTION_ERROR)
          : GENERIC_ACTION_ERROR,
      );
    },
  });

  // Error check first — when the query fails, isLoading is false but data is
  // also undefined, so we must check error before the isLoading||!data guard.
  // Mirrors the guard order in TenantList.tsx.
  if (error) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-2xl mx-auto">
          <Link
            to="/officine"
            className="text-sm text-muted-foreground hover:underline mb-4 inline-block"
          >
            ← Officine
          </Link>
          <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
            Errore nel caricamento dell&apos;officina.
          </div>
        </div>
      </div>
    );
  }

  // Loading state — also guards against offline/paused state where data may be
  // undefined even though isLoading is false.
  // See [[feedback_react_query_data_bang_offline_paused]].
  if (isLoading || !data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-2xl mx-auto">
          <Link
            to="/officine"
            className="text-sm text-muted-foreground hover:underline mb-4 inline-block"
          >
            ← Officine
          </Link>
          <p className="text-muted-foreground">Caricamento…</p>
        </div>
      </div>
    );
  }

  const statusBadge = STATUS_BADGE[data.tenant.status];

  function onSubmit(vals: TenantProfileParsed) {
    updateMutation.mutate(vals);
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto">
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
      </div>
    </div>
  );
}

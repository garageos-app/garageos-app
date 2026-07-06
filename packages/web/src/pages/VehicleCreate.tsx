// F-OFF-102 vehicle registration. Calls POST /v1/vehicles (atomic vehicle +
// GO-code F-OFF-103 + ownership BR-040 + customer-tenant relation BR-152).
// Customer is inline (existing or new) per resolveCustomer. See
// docs/superpowers/specs/2026-06-09-F-OFF-102-vehicle-create-web-design.md
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import {
  VehicleFormSchema,
  transformToPayload,
  VehicleTypeEnum,
  FuelTypeEnum,
  type VehicleFormValues,
} from '@/lib/validators/createVehicle';
import { useCreateVehicle, type CreateVehicleBody } from '@/queries/vehicleCreate';
import { useProfileMe } from '@/queries/profileMe';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CustomerAutocomplete } from '@/components/CustomerAutocomplete';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  car: 'Auto',
  motorcycle: 'Moto',
  van: 'Furgone',
  truck: 'Camion',
  agricultural: 'Agricolo',
};
const FUEL_TYPE_LABELS: Record<string, string> = {
  petrol: 'Benzina',
  diesel: 'Diesel',
  electric: 'Elettrico',
  hybrid: 'Ibrido',
  lpg: 'GPL',
  methane: 'Metano',
  hydrogen: 'Idrogeno',
  other: 'Altro',
};

export function VehicleCreate() {
  const profile = useProfileMe();

  if (profile.isPending) {
    return (
      <div className="p-4 md:p-8 space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <div className="p-4 md:p-8">
        <Alert variant="destructive">
          <AlertDescription>Errore caricamento profilo.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return <VehicleCreateForm />;
}

interface PendingConfirm {
  kind: 'plate' | 'vin';
  body: CreateVehicleBody;
  plate: string;
}

function VehicleCreateForm() {
  const navigate = useNavigate();
  const routerLocation = useLocation();
  const [params] = useSearchParams();
  const mutation = useCreateVehicle();

  const lockedCustomerId = params.get('customerId');
  const lockedCustomerLabel =
    (routerLocation.state as { customerLabel?: string } | null)?.customerLabel ?? null;
  const prefillVin = params.get('vin') ?? '';
  const prefillPlate = params.get('plate') ?? '';

  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [selectedCustomerLabel, setSelectedCustomerLabel] = useState<string | null>(
    lockedCustomerId ? (lockedCustomerLabel ?? 'Cliente selezionato') : null,
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<VehicleFormValues>({
    resolver: zodResolver(VehicleFormSchema),
    defaultValues: {
      customerMode: lockedCustomerId ? 'existing' : 'create_new',
      customerId: lockedCustomerId ?? '',
      isBusiness: false,
      vin: prefillVin.toUpperCase(),
      plate: prefillPlate.toUpperCase(),
      plateCountry: 'IT',
      year: '',
      vehicleType: 'car',
      fuelType: 'petrol',
      odometerKm: '',
    },
  });

  const customerMode = watch('customerMode');
  const isBusiness = watch('isBusiness');
  const vehicleType = watch('vehicleType');
  const fuelType = watch('fuelType');

  async function submit(body: CreateVehicleBody) {
    try {
      const res = await mutation.mutateAsync(body);
      toast.success(`Veicolo censito — codice GO ${res.vehicle.garageCode}`);
      navigate(`/vehicles/${res.vehicle.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 && e.code === 'vehicle.creation.duplicate_plate_warning') {
          setConfirm({ kind: 'plate', body, plate: body.vehicle.plate });
          return;
        }
        if (e.status === 400 && e.code === 'vehicle.creation.invalid_vin_checksum') {
          setConfirm({ kind: 'vin', body, plate: body.vehicle.plate });
          return;
        }
        toast.error(translateError(e.code, e.message));
        return;
      }
      throw e;
    }
  }

  async function onSubmit(values: VehicleFormValues) {
    await submit(transformToPayload(values));
  }

  async function onForcePlate() {
    if (!confirm) return;
    const body = { ...confirm.body, force: true };
    setConfirm(null);
    await submit(body);
  }
  async function onForceVin() {
    if (!confirm) return;
    const body = { ...confirm.body, forceNonstandardVin: true };
    setConfirm(null);
    await submit(body);
  }
  function onOpenExisting() {
    if (!confirm) return;
    navigate(`/search?q=${encodeURIComponent(confirm.plate)}`);
  }

  function err(name: keyof VehicleFormValues) {
    const e = errors[name as keyof typeof errors];
    return e ? <p className="text-sm text-red-600 mt-1">{String(e.message)}</p> : null;
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="mb-6">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={() => navigate(-1)}
        >
          ← Indietro
        </button>
        <h1 className="text-2xl font-bold mt-2">Censimento nuovo veicolo</h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-8">
        {/* ── Cliente ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Cliente</h2>

          {lockedCustomerId ? (
            <div className="rounded-md border p-3 text-sm">
              Cliente selezionato:{' '}
              <span className="font-medium">
                {selectedCustomerLabel && selectedCustomerLabel !== 'Cliente selezionato'
                  ? selectedCustomerLabel
                  : `ID ${lockedCustomerId.slice(0, 8)}…`}
              </span>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={customerMode === 'existing' ? 'default' : 'outline'}
                  onClick={() => setValue('customerMode', 'existing', { shouldValidate: false })}
                >
                  Cliente esistente
                </Button>
                <Button
                  type="button"
                  variant={customerMode === 'create_new' ? 'default' : 'outline'}
                  onClick={() => {
                    setValue('customerMode', 'create_new', { shouldValidate: false });
                    setValue('customerId', '');
                    setSelectedCustomerLabel(null);
                  }}
                >
                  Nuovo cliente
                </Button>
              </div>

              {customerMode === 'existing' ? (
                <div className="space-y-2">
                  {selectedCustomerLabel ? (
                    <div className="rounded-md border p-3 text-sm">
                      Cliente selezionato:{' '}
                      <span className="font-medium">{selectedCustomerLabel}</span>{' '}
                      <button
                        type="button"
                        className="ml-2 text-xs text-muted-foreground underline"
                        onClick={() => {
                          setValue('customerId', '');
                          setSelectedCustomerLabel(null);
                        }}
                      >
                        cambia
                      </button>
                    </div>
                  ) : (
                    <CustomerAutocomplete
                      onSelect={(c) => {
                        setValue('customerId', c.id, { shouldValidate: true });
                        const label =
                          c.isBusiness && c.businessName
                            ? c.businessName
                            : `${c.firstName} ${c.lastName}`.trim();
                        setSelectedCustomerLabel(label || c.id);
                      }}
                    />
                  )}
                  {err('customerId')}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="vc-firstName">Nome</Label>
                      <Input id="vc-firstName" {...register('firstName')} />
                      {err('firstName')}
                    </div>
                    <div>
                      <Label htmlFor="vc-lastName">Cognome</Label>
                      <Input id="vc-lastName" {...register('lastName')} />
                      {err('lastName')}
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="vc-email">Email</Label>
                    <Input id="vc-email" type="email" autoComplete="off" {...register('email')} />
                    {err('email')}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="vc-phone">Telefono (opzionale)</Label>
                      <Input id="vc-phone" {...register('phone')} />
                    </div>
                    <div>
                      <Label htmlFor="vc-taxCode">Codice fiscale (opzionale)</Label>
                      <Input id="vc-taxCode" {...register('taxCode')} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="vc-isBusiness"
                      checked={isBusiness}
                      onCheckedChange={(v) => setValue('isBusiness', v, { shouldValidate: true })}
                      aria-label="Cliente aziendale"
                    />
                    <Label htmlFor="vc-isBusiness">Cliente aziendale</Label>
                  </div>
                  {isBusiness && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="vc-businessName">Ragione sociale</Label>
                        <Input id="vc-businessName" {...register('businessName')} />
                        {err('businessName')}
                      </div>
                      <div>
                        <Label htmlFor="vc-vatNumber">P.IVA</Label>
                        <Input id="vc-vatNumber" {...register('vatNumber')} />
                        {err('vatNumber')}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Veicolo ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Veicolo</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="vc-vin">VIN</Label>
              <Input id="vc-vin" {...register('vin')} />
              {err('vin')}
            </div>
            <div>
              <Label htmlFor="vc-plate">Targa</Label>
              <Input id="vc-plate" {...register('plate')} />
              {err('plate')}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="vc-make">Marca</Label>
              <Input id="vc-make" {...register('make')} />
              {err('make')}
            </div>
            <div>
              <Label htmlFor="vc-model">Modello</Label>
              <Input id="vc-model" {...register('model')} />
              {err('model')}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="vc-year">Anno</Label>
              <Input id="vc-year" inputMode="numeric" {...register('year')} />
              {err('year')}
            </div>
            <div>
              <Label htmlFor="vc-odometerKm">Km attuali</Label>
              <Input id="vc-odometerKm" inputMode="numeric" {...register('odometerKm')} />
              {err('odometerKm')}
            </div>
            <div>
              <Label htmlFor="vc-version">Versione (opzionale)</Label>
              <Input id="vc-version" {...register('version')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo veicolo</Label>
              <Select
                value={vehicleType}
                onValueChange={(v) =>
                  setValue('vehicleType', v as VehicleFormValues['vehicleType'], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger aria-label="Tipo veicolo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VehicleTypeEnum.options.map((t) => (
                    <SelectItem key={t} value={t}>
                      {VEHICLE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Alimentazione</Label>
              <Select
                value={fuelType}
                onValueChange={(v) =>
                  setValue('fuelType', v as VehicleFormValues['fuelType'], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger aria-label="Alimentazione">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FuelTypeEnum.options.map((f) => (
                    <SelectItem key={f} value={f}>
                      {FUEL_TYPE_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="vc-registrationDate">Immatricolazione (opzionale)</Label>
              <Input id="vc-registrationDate" type="date" {...register('registrationDate')} />
              {err('registrationDate')}
            </div>
            <div>
              <Label htmlFor="vc-engineDisplacement">Cilindrata cc (opzionale)</Label>
              <Input
                id="vc-engineDisplacement"
                inputMode="numeric"
                {...register('engineDisplacement')}
              />
              {err('engineDisplacement')}
            </div>
            <div>
              <Label htmlFor="vc-powerKw">Potenza kW (opzionale)</Label>
              <Input id="vc-powerKw" inputMode="numeric" {...register('powerKw')} />
              {err('powerKw')}
            </div>
          </div>
          <div>
            <Label htmlFor="vc-color">Colore (opzionale)</Label>
            <Input id="vc-color" {...register('color')} />
          </div>
        </section>

        {/* ── Invito ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex items-center gap-2 opacity-60">
            <Switch id="vc-invite" checked={false} disabled aria-label="Invia invito all'app" />
            <Label htmlFor="vc-invite" title="Disponibile a breve">
              Invia invito all&apos;app al cliente
            </Label>
            <span className="text-xs text-muted-foreground">Disponibile a breve</span>
          </div>
        </section>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate(-1)}
            disabled={isSubmitting}
          >
            Annulla
          </Button>
          <Button type="submit" disabled={isSubmitting || mutation.isPending}>
            {isSubmitting || mutation.isPending ? 'Salvataggio…' : 'Censisci veicolo'}
          </Button>
        </div>
      </form>

      {/* Duplicate-plate dialog */}
      <Dialog open={confirm?.kind === 'plate'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Targa già presente</DialogTitle>
            <DialogDescription>
              Esiste già un veicolo con questa targa ({confirm?.plate}). Di solito significa che il
              veicolo è già a sistema.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" onClick={onOpenExisting}>
              Apri veicolo esistente
            </Button>
            <Button type="button" variant="outline" onClick={onForcePlate}>
              Censisci comunque
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VIN-checksum dialog */}
      <Dialog open={confirm?.kind === 'vin'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Controlla il numero di telaio</DialogTitle>
            <DialogDescription>
              La cifra di controllo del VIN non corrisponde allo standard ISO 3779 — comune sui
              veicoli europei. Verifica il telaio sul libretto: se è corretto, conferma per
              procedere.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
              Annulla
            </Button>
            <Button type="button" onClick={onForceVin}>
              Conferma
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

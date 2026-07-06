// F-OFF-107 certify dialog. Pre-filled with the customer's pre-registered
// data (F-CLI-104); the mechanic verifies against the physical libretto
// (BR-004 checkbox gate), optionally corrects the identity fields, and
// promotes the vehicle to certified (GO-code generated server-side).
// Only dirty fields are sent as `corrections`. Confirm flows mirror
// VehicleCreate: duplicate plate → force, VIN checksum → forceNonstandardVin.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';

import { ApiError } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import {
  VehicleTypeEnum,
  FuelTypeEnum,
  type VehicleType,
  type FuelType,
} from '@/lib/validators/createVehicle';
import {
  useCertifyVehicle,
  type CertifyVehicleBody,
  type CertifyVehicleCorrections,
} from '@/queries/vehicleCertify';
import type { VehicleDetail } from '@/queries/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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

const CURRENT_YEAR = new Date().getUTCFullYear();

// Loose client-side validation, server authoritative (same stance as
// F-OFF-102). Numerics as strings to avoid coerce-empty-to-0.
const CertifyFormSchema = z
  .object({
    vin: z.string().trim().length(17, 'Il VIN deve avere 17 caratteri'),
    plate: z.string().trim().min(1, 'Targa obbligatoria').max(10),
    make: z.string().trim().min(1, 'Marca obbligatoria').max(50),
    model: z.string().trim().min(1, 'Modello obbligatorio').max(100),
    version: z.string().max(150).optional(),
    year: z.string().regex(/^\d{4}$/, 'Anno non valido (AAAA)'),
    registrationDate: z.string().optional(),
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
    librettoVisioned: z.boolean(),
  })
  .superRefine((d, ctx) => {
    const y = Number(d.year);
    if (d.year && (y < 1900 || y > CURRENT_YEAR + 1)) {
      ctx.addIssue({ code: 'custom', path: ['year'], message: 'Anno non valido' });
    }
    if (d.registrationDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.registrationDate)) {
      ctx.addIssue({ code: 'custom', path: ['registrationDate'], message: 'Data non valida' });
    }
  });

type CertifyFormValues = z.infer<typeof CertifyFormSchema>;

interface PendingConfirm {
  kind: 'plate' | 'vin';
  body: CertifyVehicleBody;
  plate: string;
}

interface CertifyVehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle: VehicleDetail;
}

export function CertifyVehicleDialog({ open, onOpenChange, vehicle }: CertifyVehicleDialogProps) {
  const mutation = useCertifyVehicle(vehicle.id);
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // Snapshot taken ONCE at mount (the parent mounts the dialog per open):
  // it is both the form defaults and the dirty-diff baseline, so a
  // vehicle-detail refetch while the dialog is open cannot desync the two
  // and turn untouched fields into unintended corrections.
  // queries/types.ts still declares legacy enum literals for
  // vehicleType/fuelType; the wire carries the backend Prisma values
  // ('car', 'petrol', ...) — cast through the runtime truth.
  const [initial] = useState(() => ({
    vin: vehicle.vin,
    plate: vehicle.plate,
    make: vehicle.make,
    model: vehicle.model,
    version: vehicle.version ?? '',
    year: String(vehicle.year),
    registrationDate: vehicle.registrationDate?.slice(0, 10) ?? '',
    vehicleType: vehicle.vehicleType as unknown as VehicleType,
    fuelType: vehicle.fuelType as unknown as FuelType,
  }));

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CertifyFormValues>({
    resolver: zodResolver(CertifyFormSchema),
    defaultValues: { ...initial, librettoVisioned: false },
  });

  const vehicleType = watch('vehicleType');
  const fuelType = watch('fuelType');
  const librettoVisioned = watch('librettoVisioned');

  function buildCorrections(v: CertifyFormValues): CertifyVehicleCorrections | undefined {
    const c: CertifyVehicleCorrections = {};
    const vin = v.vin.trim().toUpperCase();
    if (vin !== initial.vin) c.vin = vin;
    const plate = v.plate.trim().toUpperCase();
    if (plate !== initial.plate) c.plate = plate;
    const make = v.make.trim();
    if (make !== initial.make) c.make = make;
    const model = v.model.trim();
    if (model !== initial.model) c.model = model;
    const version = (v.version ?? '').trim();
    if (version !== initial.version) c.version = version || null;
    if (v.year !== initial.year) c.year = Number(v.year);
    const registrationDate = (v.registrationDate ?? '').trim();
    if (registrationDate !== initial.registrationDate) {
      c.registrationDate = registrationDate || null;
    }
    if (v.vehicleType !== initial.vehicleType) c.vehicleType = v.vehicleType;
    if (v.fuelType !== initial.fuelType) c.fuelType = v.fuelType;
    return Object.keys(c).length > 0 ? c : undefined;
  }

  async function submit(body: CertifyVehicleBody) {
    try {
      const res = await mutation.mutateAsync(body);
      toast.success(`Veicolo certificato — codice GO ${res.vehicle.garageCode}`);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 && e.code === 'vehicle.creation.duplicate_plate_warning') {
          setConfirm({ kind: 'plate', body, plate: body.corrections?.plate ?? vehicle.plate });
          return;
        }
        if (e.status === 400 && e.code === 'vehicle.creation.invalid_vin_checksum') {
          setConfirm({ kind: 'vin', body, plate: body.corrections?.plate ?? vehicle.plate });
          return;
        }
        toast.error(translateError(e.code, e.message));
        if (e.code === 'vehicle.certification.not_pending') {
          // A concurrent certify won (or the page is stale): close and
          // refetch so the banner/dialog stop claiming the vehicle is
          // still pending.
          void qc.invalidateQueries({ queryKey: ['vehicle-detail', vehicle.id] });
          onOpenChange(false);
        }
        return;
      }
      throw e;
    }
  }

  async function onSubmit(values: CertifyFormValues) {
    const corrections = buildCorrections(values);
    await submit({
      librettoVisioned: values.librettoVisioned,
      ...(corrections !== undefined ? { corrections } : {}),
    });
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

  function err(name: keyof CertifyFormValues) {
    const e = errors[name];
    return e ? <p className="text-xs text-destructive mt-1">{e.message as string}</p> : null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Certifica veicolo</DialogTitle>
            <DialogDescription>
              Verifica i dati con il libretto di circolazione e correggi se necessario. Alla
              conferma il veicolo riceve il codice GarageOS ufficiale.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cd-vin">VIN</Label>
                <Input id="cd-vin" {...register('vin')} />
                {err('vin')}
              </div>
              <div>
                <Label htmlFor="cd-plate">Targa</Label>
                <Input id="cd-plate" {...register('plate')} />
                {err('plate')}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cd-make">Marca</Label>
                <Input id="cd-make" {...register('make')} />
                {err('make')}
              </div>
              <div>
                <Label htmlFor="cd-model">Modello</Label>
                <Input id="cd-model" {...register('model')} />
                {err('model')}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="cd-year">Anno</Label>
                <Input id="cd-year" inputMode="numeric" {...register('year')} />
                {err('year')}
              </div>
              <div>
                <Label htmlFor="cd-version">Versione</Label>
                <Input id="cd-version" {...register('version')} />
              </div>
              <div>
                <Label htmlFor="cd-registrationDate">Immatricolazione</Label>
                <Input id="cd-registrationDate" type="date" {...register('registrationDate')} />
                {err('registrationDate')}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tipo veicolo</Label>
                <Select
                  value={vehicleType}
                  onValueChange={(v) =>
                    setValue('vehicleType', v as VehicleType, { shouldValidate: true })
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
                    setValue('fuelType', v as FuelType, { shouldValidate: true })
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
            <div className="flex items-center gap-2 pt-2">
              <Switch
                id="cd-libretto"
                checked={librettoVisioned}
                onCheckedChange={(v) => setValue('librettoVisioned', v, { shouldValidate: true })}
                aria-label="Ho visionato il libretto di circolazione"
              />
              <Label htmlFor="cd-libretto">Ho visionato il libretto di circolazione</Label>
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Annulla
              </Button>
              {/* BR-004: the explicit libretto declaration gates the submit. */}
              <Button
                type="submit"
                disabled={!librettoVisioned || isSubmitting || mutation.isPending}
              >
                {isSubmitting || mutation.isPending ? 'Certificazione…' : 'Certifica veicolo'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Duplicate-plate confirm */}
      <Dialog open={confirm?.kind === 'plate'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Targa già presente</DialogTitle>
            <DialogDescription>
              Esiste già un veicolo con questa targa ({confirm?.plate}). Confermi la correzione?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
              Annulla
            </Button>
            <Button type="button" onClick={onForcePlate}>
              Conferma
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VIN-checksum confirm */}
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
    </>
  );
}

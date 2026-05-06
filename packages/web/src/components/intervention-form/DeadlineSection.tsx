import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

export function DeadlineSection() {
  const { control, register } = useFormContext<CreateInterventionFormValues>();
  const enabled = useWatch({ control, name: 'createDeadline.enabled' }) ?? false;

  return (
    <div className="space-y-3">
      <Controller
        control={control}
        name="createDeadline.enabled"
        render={({ field }) => (
          <div className="flex items-center gap-2">
            <Switch checked={!!field.value} onCheckedChange={field.onChange} />
            <Label>Programma scadenza per il prossimo intervento</Label>
          </div>
        )}
      />
      {enabled && (
        <div className="grid grid-cols-2 gap-3 pl-8">
          <div>
            <Label htmlFor="months">Mesi da oggi</Label>
            <Input id="months" type="number" {...register('createDeadline.monthsFromNow')} />
          </div>
          <div>
            <Label htmlFor="kmIncrement">Incremento km</Label>
            <Input id="kmIncrement" type="number" {...register('createDeadline.kmIncrement')} />
          </div>
        </div>
      )}
    </div>
  );
}

import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatDeadlineSuggestion, type DeadlineSuggestion } from '@/lib/deadline-suggestion';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

interface DeadlineSectionProps {
  /** F-OFF-308 suggestion for the currently selected intervention type. */
  suggestion?: DeadlineSuggestion | null;
}

export function DeadlineSection({ suggestion = null }: DeadlineSectionProps) {
  const { control, register } = useFormContext<CreateInterventionFormValues>();
  const enabled = useWatch({ control, name: 'createDeadline.enabled' }) ?? false;
  const suggestionText = suggestion ? formatDeadlineSuggestion(suggestion) : null;

  return (
    <div className="space-y-3">
      {suggestionText && <p className="text-sm text-muted-foreground">{suggestionText}</p>}
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
            <Input
              id="months"
              type="number"
              {...register('createDeadline.monthsFromNow', { valueAsNumber: true })}
            />
          </div>
          <div>
            <Label htmlFor="kmIncrement">Incremento km</Label>
            <Input
              id="kmIncrement"
              type="number"
              {...register('createDeadline.kmIncrement', { valueAsNumber: true })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

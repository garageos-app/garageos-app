import { Plus, Trash2 } from 'lucide-react';
import { type FieldValues, useFieldArray, useFormContext } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BasePartReplaced } from '@/lib/validators/parts-replaced';

// Form values must include a `partsReplaced` array of BasePartReplaced.
// Both CreateInterventionFormValues and EditInterventionFormValues
// satisfy this constraint, so PartsRepeater is reusable across forms
// without an unsound cast.
type PartsFormValues = FieldValues & { partsReplaced: BasePartReplaced[] };

export function PartsRepeater<TFormValues extends PartsFormValues>() {
  const { control, register } = useFormContext<TFormValues>();
  const { fields, append, remove } = useFieldArray<TFormValues>({
    control,
    name: 'partsReplaced' as never,
  });

  return (
    <div className="space-y-2">
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nessun pezzo registrato.</p>
      ) : (
        fields.map((f, i) => (
          <div key={f.id} className="grid grid-cols-[1fr_120px_80px_36px] gap-2 items-start">
            <Input placeholder="Nome pezzo" {...register(`partsReplaced.${i}.name` as never)} />
            <Input placeholder="Codice (opz)" {...register(`partsReplaced.${i}.code` as never)} />
            <Input
              type="number"
              placeholder="Quantità"
              step="1"
              min={1}
              {...register(`partsReplaced.${i}.quantity` as never, { valueAsNumber: true })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Rimuovi pezzo ${i + 1}`}
              onClick={() => remove(i)}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ name: '', quantity: 1 } as never)}
      >
        <Plus size={14} className="mr-1" /> Aggiungi pezzo
      </Button>
    </div>
  );
}

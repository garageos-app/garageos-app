import { Plus, Trash2 } from 'lucide-react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// PartsRepeater renders a parts array editor expected at form path
// `partsReplaced`. Both call sites (InterventionForm, EditInterventionDialog)
// mount this component inside a FormProvider whose form values include a
// `partsReplaced` array of BasePartReplaced. The component uses RHF's
// untyped overloads (useFormContext / useFieldArray without type arguments),
// which accept any string path — no generic or cast is needed.

export function PartsRepeater() {
  const { control, register } = useFormContext();
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'partsReplaced',
  });

  return (
    <div className="space-y-2">
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nessun pezzo registrato.</p>
      ) : (
        fields.map((f, i) => (
          <div key={f.id} className="grid grid-cols-[1fr_120px_80px_36px] gap-2 items-start">
            <Input placeholder="Nome pezzo" {...register(`partsReplaced.${i}.name`)} />
            <Input placeholder="Codice (opz)" {...register(`partsReplaced.${i}.code`)} />
            <Input
              type="number"
              placeholder="Quantità"
              step="1"
              min={1}
              {...register(`partsReplaced.${i}.quantity`, { valueAsNumber: true })}
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
        onClick={() => append({ name: '', quantity: 1 })}
      >
        <Plus size={14} className="mr-1" /> Aggiungi pezzo
      </Button>
    </div>
  );
}

// IT-strings — hardcoded
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { parseSearchInput } from '@/lib/search-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function Dashboard() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseSearchInput(value);
    if (parsed.kind === 'invalid') {
      setError(
        'Inserisci un VIN (17 caratteri), una targa, o un codice GarageOS (formato GO-XXX-XXXX).',
      );
      return;
    }
    setError(null);
    navigate(`/search?q=${encodeURIComponent(parsed.value)}&t=${parsed.type}`);
  };

  const hint = (() => {
    const p = parseSearchInput(value);
    if (p.kind === 'invalid') return null;
    if (p.type === 'vin') return '→ ricerca per VIN';
    if (p.type === 'plate') return '→ ricerca per targa';
    return '→ ricerca per codice GarageOS';
  })();

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-8">
      <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 mb-2">
        Cerca un veicolo
      </h1>
      <p className="text-slate-600 mb-8">VIN, targa o codice GarageOS</p>
      <form onSubmit={onSubmit} noValidate className="w-full max-w-2xl space-y-3">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <Input
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Inserisci VIN, targa o codice GO-…"
              className="h-14 pl-11 text-base"
              autoFocus
            />
          </div>
          <Button type="submit" size="lg" className="h-14 px-6">
            Cerca →
          </Button>
        </div>
        {hint && <div className="text-xs text-slate-500 pl-1">{hint}</div>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </form>
    </div>
  );
}

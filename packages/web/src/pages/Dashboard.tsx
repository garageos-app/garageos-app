// IT-strings — hardcoded, no i18n in demo-2
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';

import { parseSearchInput } from '@/lib/search-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CustomerAutocomplete } from '@/components/CustomerAutocomplete';

type Tab = 'vehicle' | 'customer';

export function Dashboard() {
  const [tab, setTab] = useState<Tab>('vehicle');

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-8">
      <h1 className="text-4xl font-extrabold tracking-tight text-foreground mb-2">Cerca</h1>
      <p className="text-muted-foreground mb-6">
        {tab === 'vehicle' ? 'VIN, targa o codice GarageOS' : 'Nome o ragione sociale del cliente'}
      </p>

      <div className="flex gap-2 mb-6" role="tablist" aria-label="Modalità di ricerca">
        <Button
          type="button"
          role="tab"
          aria-selected={tab === 'vehicle'}
          variant={tab === 'vehicle' ? 'default' : 'outline'}
          onClick={() => setTab('vehicle')}
        >
          Veicolo
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={tab === 'customer'}
          variant={tab === 'customer' ? 'default' : 'outline'}
          onClick={() => setTab('customer')}
        >
          Cliente
        </Button>
      </div>

      {tab === 'vehicle' ? <VehicleSearchForm /> : <CustomerSearchPanel />}
    </div>
  );
}

function VehicleSearchForm() {
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
    <form onSubmit={onSubmit} noValidate className="w-full max-w-2xl space-y-3">
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
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
      {hint && <div className="text-xs text-muted-foreground pl-1">{hint}</div>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

function CustomerSearchPanel() {
  const navigate = useNavigate();
  return (
    <div className="w-full max-w-2xl">
      <CustomerAutocomplete onSelect={(c) => navigate(`/search?customer=${c.id}&t=customer`)} />
    </div>
  );
}

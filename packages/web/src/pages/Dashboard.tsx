// IT-strings — hardcoded, no i18n in demo-2
import { useEffect, useRef, useState } from 'react';
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
  const vehicleTabRef = useRef<HTMLButtonElement>(null);
  const customerTabRef = useRef<HTMLButtonElement>(null);
  // Set on keyboard-driven tab changes so the post-render effect knows
  // to move focus to the newly-selected tab (instead of letting the new
  // panel's autoFocus claim focus). Click-driven changes leave this
  // false — the user already pressed a mouse, focus moves naturally.
  const keyboardTriggeredRef = useRef(false);

  useEffect(() => {
    if (!keyboardTriggeredRef.current) return;
    keyboardTriggeredRef.current = false;
    (tab === 'vehicle' ? vehicleTabRef : customerTabRef).current?.focus();
  }, [tab]);

  // WAI-ARIA Tabs keyboard handler: left/right arrow keys move focus
  // between tabs within the tablist. Required because we use roving
  // tabIndex (only the active tab is in the Tab key stop sequence),
  // so without this handler arrow navigation is unreachable.
  // TODO when adding a 3rd tab: switch to functional setTab updater
  // (`setTab(prev => ...)`) — the current binary toggle reads `tab` from
  // closure and would race on rapid double keypress with 3+ tabs.
  function onTabsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    keyboardTriggeredRef.current = true;
    setTab(tab === 'vehicle' ? 'customer' : 'vehicle');
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-8">
      <h1 className="text-4xl font-extrabold tracking-tight text-foreground mb-2">Cerca</h1>
      <p className="text-muted-foreground mb-6">
        {tab === 'vehicle' ? 'VIN, targa o codice GarageOS' : 'Nome o ragione sociale del cliente'}
      </p>

      <div
        className="flex gap-2 mb-6"
        role="tablist"
        aria-label="Modalità di ricerca"
        onKeyDown={onTabsKeyDown}
      >
        <Button
          ref={vehicleTabRef}
          type="button"
          role="tab"
          id="tab-vehicle"
          aria-controls="panel-vehicle"
          aria-selected={tab === 'vehicle'}
          tabIndex={tab === 'vehicle' ? 0 : -1}
          variant={tab === 'vehicle' ? 'default' : 'outline'}
          onClick={() => setTab('vehicle')}
        >
          Veicolo
        </Button>
        <Button
          ref={customerTabRef}
          type="button"
          role="tab"
          id="tab-customer"
          aria-controls="panel-customer"
          aria-selected={tab === 'customer'}
          tabIndex={tab === 'customer' ? 0 : -1}
          variant={tab === 'customer' ? 'default' : 'outline'}
          onClick={() => setTab('customer')}
        >
          Cliente
        </Button>
      </div>

      <div
        role="tabpanel"
        id={tab === 'vehicle' ? 'panel-vehicle' : 'panel-customer'}
        aria-labelledby={tab === 'vehicle' ? 'tab-vehicle' : 'tab-customer'}
      >
        {tab === 'vehicle' ? <VehicleSearchForm /> : <CustomerSearchPanel />}
      </div>
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

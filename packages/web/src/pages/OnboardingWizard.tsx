import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { LocationManagement } from '@/pages/LocationManagement';
import { UserManagement } from '@/pages/UserManagement';
import { TenantForm } from '@/components/settings/TenantForm';
import { useTenantMe } from '@/queries/tenantMe';
import { useCompleteOnboarding } from '@/queries/tenantOnboarding';

// F-OFF-002 — guided onboarding wizard. Full-page (rendered outside
// AppLayout). Reuses the Settings section components for each step.
// «Salta» does NOT persist the flag (the wizard reappears next login);
// only «Fine» calls complete. «Fine» is best-effort: on failure we
// still navigate home (the gate will re-prompt on next login).

const STEPS = [
  { title: 'Le tue sedi', subtitle: 'Conferma la sede principale o aggiungine altre.' },
  { title: 'Il tuo team', subtitle: 'Invita i meccanici della tua officina (opzionale).' },
  { title: 'Dati officina', subtitle: 'Conferma i dati anagrafici della tua officina.' },
] as const;

export function OnboardingWizard() {
  const navigate = useNavigate();
  const tenantQ = useTenantMe();
  const completeMut = useCompleteOnboarding();
  const [step, setStep] = useState<0 | 1 | 2>(0);

  function skipAll() {
    // Intentionally does NOT call complete — see header comment.
    navigate('/');
  }

  async function finish() {
    try {
      await completeMut.mutateAsync();
      navigate('/', { state: { flash: 'Configurazione completata.' } });
    } catch {
      toast.error('Non è stato possibile salvare; ti richiederemo al prossimo accesso.');
      navigate('/');
    }
  }

  const current = STEPS[step];

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 space-y-8">
        <header className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Passaggio {step + 1} di {STEPS.length}
            </span>
            <Button variant="ghost" size="sm" onClick={skipAll}>
              Salta configurazione
            </Button>
          </div>
          <div className="flex gap-2" aria-hidden="true">
            {STEPS.map((s, i) => (
              <div
                key={s.title}
                className={`h-1.5 flex-1 rounded ${i <= step ? 'bg-foreground' : 'bg-border'}`}
              />
            ))}
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{current.title}</h1>
            <p className="text-muted-foreground">{current.subtitle}</p>
          </div>
        </header>

        <main className="rounded-lg border p-6">
          {step === 0 && <LocationManagement />}
          {step === 1 && <UserManagement />}
          {step === 2 &&
            (tenantQ.isError ? (
              <p className="text-red-600">Errore nel caricare i dati officina.</p>
            ) : tenantQ.data ? (
              <TenantForm tenant={tenantQ.data} />
            ) : (
              <p>Caricamento...</p>
            ))}
        </main>

        <footer className="flex items-center justify-between">
          <Button
            variant="ghost"
            disabled={step === 0}
            onClick={() => setStep((s) => (s > 0 ? ((s - 1) as 0 | 1 | 2) : s))}
          >
            Indietro
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => (s < 2 ? ((s + 1) as 0 | 1 | 2) : s))}>
              Avanti
            </Button>
          ) : (
            <Button onClick={finish} disabled={completeMut.isPending}>
              {completeMut.isPending ? 'Salvataggio…' : 'Fine'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface ApiError {
  type?: string;
  detail?: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

function errorMessage(err: ApiError | null): string {
  if (!err) return 'Si è verificato un errore. Riprova più tardi.';
  if (err.type?.includes('verify_email.token_expired')) {
    return 'Il link è scaduto. Apri l\'app GarageOS e richiedi un nuovo link con "Invia di nuovo".';
  }
  if (err.type?.includes('verify_email.token_consumed')) {
    return "Questo link è già stato utilizzato. Apri l'app GarageOS ed effettua l'accesso.";
  }
  if (err.type?.includes('verify_email.token_not_found')) {
    return 'Link non valido. Apri l\'app GarageOS e richiedi un nuovo link con "Invia di nuovo".';
  }
  return err.detail ?? 'Si è verificato un errore. Riprova più tardi.';
}

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!token) return;
    setStatus('loading');
    fetch(`${API_BASE_URL}/v1/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (resp) => {
        if (resp.ok) {
          setStatus('success');
          return;
        }
        const body = (await resp.json().catch(() => ({}))) as ApiError;
        setError(body);
        setStatus('error');
      })
      .catch((err) => {
        setError({ detail: err instanceof Error ? err.message : String(err) });
        setStatus('error');
      });
  }, [token]);

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full bg-card rounded-xl p-8 shadow-lg">
          <h1 className="text-2xl font-semibold text-foreground mb-2">Link non valido</h1>
          <p className="text-muted-foreground">
            Il link di verifica è incompleto. Apri l&apos;app GarageOS sul tuo telefono e richiedi
            un nuovo link con &laquo;Invia di nuovo&raquo;.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full bg-card rounded-xl p-8 shadow-lg text-center">
        {status === 'loading' && (
          <>
            <h1 className="text-2xl font-semibold text-foreground mb-2">Verifica in corso…</h1>
            <p className="text-muted-foreground">Stiamo confermando il tuo indirizzo email.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <h1 className="text-2xl font-semibold text-foreground mb-2">Email verificata</h1>
            <p className="text-muted-foreground">
              Il tuo account è ora attivo. Torna all&apos;app GarageOS sul tuo telefono ed effettua
              l&apos;accesso.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <h1 className="text-2xl font-semibold text-foreground mb-2">Verifica fallita</h1>
            <p className="text-muted-foreground">{errorMessage(error)}</p>
          </>
        )}
      </div>
    </div>
  );
}

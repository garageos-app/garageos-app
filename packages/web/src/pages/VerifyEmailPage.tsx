import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface ApiError {
  type?: string;
  detail?: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

function errorMessage(err: ApiError | null): string {
  if (!err) return 'Si è verificato un errore. Riprova più tardi.';
  if (err.type?.includes('verify_email.token_expired')) {
    return 'Il link è scaduto. Richiedi un nuovo link via "Invia di nuovo" nella pagina di login.';
  }
  if (err.type?.includes('verify_email.token_consumed')) {
    return 'Questo link è già stato utilizzato. Effettua il login.';
  }
  if (err.type?.includes('verify_email.token_not_found')) {
    return 'Link non valido. Richiedi un nuovo link via "Invia di nuovo" nella pagina di login.';
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
          <p className="text-muted-foreground mb-6">
            Il link di verifica è incompleto. Richiedi un nuovo link dalla pagina di login.
          </p>
          <Link
            to="/login"
            className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium"
          >
            Vai al login
          </Link>
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
            <p className="text-muted-foreground mb-6">
              Il tuo account è ora attivo. Effettua il login per iniziare.
            </p>
            <Link
              to="/login"
              className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium"
            >
              Vai al login
            </Link>
          </>
        )}
        {status === 'error' && (
          <>
            <h1 className="text-2xl font-semibold text-foreground mb-2">Verifica fallita</h1>
            <p className="text-muted-foreground mb-6">{errorMessage(error)}</p>
            <Link
              to="/login"
              className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium"
            >
              Vai al login
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

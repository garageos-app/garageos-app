import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApiFetch } from '@/lib/api-client';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Shape returned by GET /v1/admin/me — all fields are always present (default '').
interface AdminMe {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
}

export function PlatformConsole() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const apiFetch = useApiFetch();

  const { data, isLoading, error } = useQuery<AdminMe>({
    queryKey: ['admin-me'],
    queryFn: () => apiFetch<AdminMe>('/v1/admin/me'),
  });

  // Compose display name from name parts; fall back to email.
  const displayName = data
    ? [data.firstName, data.lastName].filter(Boolean).join(' ') || data.email
    : undefined;

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">Console piattaforma</h1>
          <div className="flex items-center gap-3">
            <Button onClick={() => navigate('/officine/nuova')}>Crea officina</Button>
            <Button variant="outline" onClick={signOut}>
              Esci
            </Button>
          </div>
        </div>

        {isLoading && <p className="text-muted-foreground">Caricamento...</p>}

        {error && (
          <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
            Errore nel caricamento del profilo. Riprova.
          </div>
        )}

        {!isLoading && !error && data && (
          <Card>
            <CardHeader>
              <CardTitle>{displayName}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{data.email}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

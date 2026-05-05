import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function Dashboard() {
  const { state, signOut } = useAuth();
  const userLabel = state.status === 'authenticated' ? state.user.email : '';

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Benvenuto in GarageOS</h1>
            <p className="text-slate-600">{userLabel}</p>
          </div>
          <Button variant="outline" onClick={signOut}>
            Esci
          </Button>
        </div>
        <Card>
          <CardContent className="p-8 text-center text-slate-500">
            Le funzionalità della dashboard arriveranno nelle prossime versioni.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { useParams, Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useInvitation, useAcceptInvitation } from '@/queries/users-admin';
import type { ApiError } from '@/lib/api-client';

// ─── Schema ───────────────────────────────────────────────────────────────────

const acceptSchema = z
  .object({
    password: z.string().min(8, 'La password deve contenere almeno 8 caratteri').max(256),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Le password non coincidono',
    path: ['confirmPassword'],
  });

type AcceptValues = z.infer<typeof acceptSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  mechanic: 'Meccanico',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function AcceptInvitation() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const { data: invitation, isLoading, isError, error } = useInvitation(token);
  const acceptMutation = useAcceptInvitation();

  const form = useForm<AcceptValues>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const { isSubmitting } = form.formState;
  const formError = form.formState.errors.root?.message;

  async function onSubmit(values: AcceptValues) {
    try {
      await acceptMutation.mutateAsync({ token, body: { password: values.password } });
      toast.success('Account creato. Effettua il login.');
      navigate('/login?invited=1', { replace: true });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr?.code === 'user.invitation.accept_password_policy') {
        form.setError('password', {
          message: apiErr.message || 'La password non rispetta i requisiti minimi.',
        });
        return;
      }
      const status = apiErr?.status ?? 0;
      if (status === 404 || status === 410) {
        form.setError('root', { message: 'Invito non valido o scaduto.' });
        return;
      }
      form.setError('root', {
        message: apiErr?.message || 'Si è verificato un errore. Riprova più tardi.',
      });
    }
  }

  // ─── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full bg-card rounded-xl p-8 shadow-lg text-center">
          <p className="text-muted-foreground">Caricamento invito…</p>
        </div>
      </div>
    );
  }

  // ─── Error / invalid token state ────────────────────────────────────────────
  if (isError) {
    const apiErr = error as ApiError | null;
    const isNotFound = apiErr?.status === 404 || apiErr?.status === 410;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full bg-card rounded-xl p-8 shadow-lg text-center">
          <h1 className="text-2xl font-semibold text-foreground mb-2">Invito non valido</h1>
          <p className="text-muted-foreground mb-6">
            {isNotFound
              ? 'Invito non valido o scaduto.'
              : (apiErr?.message ?? 'Si è verificato un errore. Riprova più tardi.')}
          </p>
          <Link
            to="/"
            className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium"
          >
            Torna alla home
          </Link>
        </div>
      </div>
    );
  }

  // ─── Invitation loaded — show form ──────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full bg-card rounded-xl p-8 shadow-lg">
        <h1 className="text-2xl font-semibold text-foreground mb-2">Accetta invito</h1>
        <p className="text-muted-foreground mb-6">
          Completa la registrazione impostando la tua password.
        </p>

        {/* Read-only summary */}
        {invitation && (
          <div className="mb-6 space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Nome</span>
              <span className="font-medium">
                {invitation.firstName} {invitation.lastName}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span className="font-medium">{invitation.targetEmail}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ruolo</span>
              <span className="font-medium">{ROLE_LABEL[invitation.role] ?? invitation.role}</span>
            </div>
          </div>
        )}

        {/* Form-level error banner */}
        {formError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...form.register('password')}
            />
            <p className="text-xs text-muted-foreground">Almeno 8 caratteri.</p>
            {form.formState.errors.password && (
              <p className="text-sm text-red-600">{form.formState.errors.password.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Conferma password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...form.register('confirmPassword')}
            />
            {form.formState.errors.confirmPassword && (
              <p className="text-sm text-red-600">
                {form.formState.errors.confirmPassword.message}
              </p>
            )}
          </div>

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? 'Registrazione in corso…' : 'Accetta invito'}
          </Button>
        </form>
      </div>
    </div>
  );
}

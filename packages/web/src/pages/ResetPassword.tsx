import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '@/components/layout/AuthLayout';
import {
  useConfirmPasswordReset,
  useRequestPasswordReset,
  type ConfirmResetCode,
} from '@/queries/passwordReset';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

const schema = z
  .object({
    code: z.string().min(1, 'Inserisci il codice ricevuto via email'),
    newPassword: z.string().min(8, 'La password deve avere almeno 8 caratteri'),
    confirmPassword: z.string().min(1, 'Conferma la password'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Le password non coincidono',
  });
type Values = z.infer<typeof schema>;

const CONFIRM_ERROR_MESSAGES: Record<ConfirmResetCode, string> = {
  code_invalid: 'Codice non valido.',
  code_expired: 'Codice scaduto. Richiedine uno nuovo.',
  password_too_weak: 'La password non rispetta i requisiti minimi.',
  rate_limited: 'Troppi tentativi. Riprova tra qualche minuto.',
  unknown: 'Impossibile contattare il server. Riprova.',
};

export function ResetPassword() {
  const [params] = useSearchParams();
  const email = params.get('email');
  const navigate = useNavigate();
  const confirm = useConfirmPasswordReset();
  const resend = useRequestPasswordReset();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', newPassword: '', confirmPassword: '' },
  });

  if (!email) return <Navigate to="/forgot-password" replace />;

  const onSubmit = async (data: Values) => {
    setError(null);
    setNotice(null);
    const result = await confirm.mutate(email, data.code, data.newPassword);
    if (result.ok) {
      navigate('/login', {
        replace: true,
        state: { flash: 'Password aggiornata. Accedi con la nuova password.' },
      });
      return;
    }
    setError(CONFIRM_ERROR_MESSAGES[result.code]);
  };

  const onResend = async () => {
    setError(null);
    setNotice(null);
    const result = await resend.mutate(email);
    if (result.ok) {
      setNotice('Ti abbiamo inviato un nuovo codice.');
      return;
    }
    setError(
      result.code === 'rate_limited'
        ? CONFIRM_ERROR_MESSAGES.rate_limited
        : CONFIRM_ERROR_MESSAGES.unknown,
    );
  };

  return (
    <AuthLayout>
      <h1 className="text-slate-100 text-xl font-semibold mb-1">Reimposta password</h1>
      <p className="text-slate-400 text-sm mb-4">
        Inserisci il codice ricevuto via email e scegli una nuova password.
      </p>
      {notice && (
        <Alert className="mb-4 bg-emerald-950/50 border-emerald-700 text-emerald-100">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4 bg-red-950/50 border-red-700 text-red-100">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-slate-300">Codice</FormLabel>
                <FormControl>
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="bg-white/[0.08] border-white/[0.15] text-slate-100 placeholder:text-slate-500 focus-visible:ring-[#4a90d9]/40 focus-visible:ring-2"
                    {...field}
                  />
                </FormControl>
                <FormMessage className="text-red-300" />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="newPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-slate-300">Nuova password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    className="bg-white/[0.08] border-white/[0.15] text-slate-100 placeholder:text-slate-500 focus-visible:ring-[#4a90d9]/40 focus-visible:ring-2"
                    {...field}
                  />
                </FormControl>
                <FormMessage className="text-red-300" />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-slate-300">Conferma password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    className="bg-white/[0.08] border-white/[0.15] text-slate-100 placeholder:text-slate-500 focus-visible:ring-[#4a90d9]/40 focus-visible:ring-2"
                    {...field}
                  />
                </FormControl>
                <FormMessage className="text-red-300" />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            disabled={confirm.isPending}
            className="w-full bg-[#4a90d9] hover:bg-[#3a7fc9] disabled:bg-[#4a90d9]/50 text-white font-medium"
          >
            {confirm.isPending ? 'Reimpostazione...' : 'Reimposta password'}
          </Button>
        </form>
      </Form>
      <button
        type="button"
        onClick={onResend}
        disabled={resend.isPending}
        className="block w-full mt-3 text-center text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50"
      >
        Invia di nuovo il codice
      </button>
      <Link
        to="/login"
        className="block mt-2 text-center text-sm text-slate-400 hover:text-slate-200"
      >
        Torna al login
      </Link>
    </AuthLayout>
  );
}

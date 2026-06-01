import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useRequestPasswordReset } from '@/queries/passwordReset';
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

const schema = z.object({ email: z.string().email("Inserisci un'email valida") });
type Values = z.infer<typeof schema>;

export function ForgotPassword() {
  const navigate = useNavigate();
  const { mutate, isPending } = useRequestPasswordReset();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '' } });

  const onSubmit = async (data: Values) => {
    setError(null);
    const result = await mutate(data.email);
    if (result.ok) {
      navigate(`/reset-password?email=${encodeURIComponent(data.email)}`);
      return;
    }
    setError(
      result.code === 'rate_limited'
        ? 'Troppi tentativi. Riprova tra qualche minuto.'
        : 'Impossibile contattare il server. Riprova.',
    );
  };

  return (
    <AuthLayout>
      <h1 className="text-slate-100 text-xl font-semibold mb-1">Password dimenticata</h1>
      <p className="text-slate-400 text-sm mb-4">
        Inserisci la tua email: ti invieremo un codice per reimpostare la password.
      </p>
      {error && (
        <Alert variant="destructive" className="mb-4 bg-red-950/50 border-red-700 text-red-100">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-slate-300">Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="email@officina.it"
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
            disabled={isPending}
            className="w-full bg-[#4a90d9] hover:bg-[#3a7fc9] disabled:bg-[#4a90d9]/50 text-white font-medium"
          >
            {isPending ? 'Invio in corso...' : 'Invia codice'}
          </Button>
        </form>
      </Form>
      <Link
        to="/login"
        className="block mt-4 text-center text-sm text-slate-400 hover:text-slate-200"
      >
        Torna al login
      </Link>
    </AuthLayout>
  );
}

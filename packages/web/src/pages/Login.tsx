import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { AuthLayout } from '@/components/layout/AuthLayout';
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

const loginSchema = z.object({
  email: z.string().email("Inserisci un'email valida"),
  password: z.string().min(1, 'Inserisci la password'),
});

type LoginValues = z.infer<typeof loginSchema>;

export function Login() {
  const navigate = useNavigate();
  const { state, signIn } = useAuth();

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (state.status === 'authenticated') {
      navigate('/', { replace: true });
    }
  }, [state.status, navigate]);

  const onSubmit = (data: LoginValues) => signIn(data.email, data.password);

  const error = state.status === 'unauthenticated' ? state.error : undefined;
  const submitting = state.status === 'authenticating';

  const location = useLocation();
  const flash = (location.state as { flash?: string } | null)?.flash;

  return (
    <AuthLayout>
      {flash && (
        <Alert className="mb-4 bg-emerald-950/50 border-emerald-700 text-emerald-100">
          <AlertDescription>{flash}</AlertDescription>
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
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-slate-300">Password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="current-password"
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
            disabled={submitting}
            className="w-full bg-[#4a90d9] hover:bg-[#3a7fc9] disabled:bg-[#4a90d9]/50 text-white font-medium"
          >
            {submitting ? 'Accesso in corso...' : 'Accedi'}
          </Button>
        </form>
      </Form>
      <Link
        to="/forgot-password"
        className="block mt-4 text-center text-sm text-slate-400 hover:text-slate-200"
      >
        Password dimenticata?
      </Link>
    </AuthLayout>
  );
}

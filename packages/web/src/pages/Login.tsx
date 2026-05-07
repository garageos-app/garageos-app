import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
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

  return (
    <div className="min-h-screen relative bg-[radial-gradient(ellipse_at_center,#1a3358_0%,#0d1f3a_70%,#081428_100%)] flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-6xl mx-auto md:grid md:grid-cols-2 md:gap-12 md:items-center">
          {/* Branding panel — top on mobile, left on desktop */}
          <div className="flex flex-col items-center md:items-start gap-4 mb-8 md:mb-0">
            <img
              src="/garageos-logo.png"
              alt="GarageOS — Digital Maintenance Logs"
              width={1376}
              height={768}
              className="max-w-[200px] md:max-w-[260px] h-auto"
            />
            <p className="text-slate-300 text-base md:text-lg text-center md:text-left max-w-md">
              Il libretto di manutenzione digitale per la tua officina
            </p>
          </div>

          {/* Form panel — bottom on mobile, right on desktop */}
          <div className="w-full max-w-sm mx-auto md:max-w-md md:mx-0">
            <div className="bg-white/[0.06] backdrop-blur-md border border-white/[0.12] rounded-lg p-6 md:p-8">
              {error && (
                <Alert
                  variant="destructive"
                  className="mb-4 bg-red-950/50 border-red-700 text-red-100"
                >
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
            </div>
          </div>
        </div>
      </main>

      {/* Footer — AI Folly logo + copyright */}
      <footer className="py-6 px-4 flex flex-col items-center gap-2 border-t border-white/[0.05]">
        <img
          src="/aifolly-logo.png"
          alt="Powered by AI Folly"
          width={1376}
          height={768}
          className="max-w-[60px] h-auto opacity-75"
        />
        <p className="text-slate-500 text-xs">
          &copy; 2026 AI Folly Srl &mdash; Tutti i diritti riservati
        </p>
      </footer>
    </div>
  );
}

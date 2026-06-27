import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const setPasswordSchema = z
  .object({
    newPassword: z.string().min(8, 'La password deve avere almeno 8 caratteri'),
    confirmPassword: z.string().min(1, 'Conferma la password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Le password non corrispondono',
    path: ['confirmPassword'],
  });

type SetPasswordValues = z.infer<typeof setPasswordSchema>;

export function SetPassword() {
  const { state, completeNewPassword } = useAuth();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SetPasswordValues>({
    resolver: zodResolver(setPasswordSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  // Redirect after the challenge is successfully completed.
  if (state.status === 'authenticated') return <Navigate to="/" replace />;

  const onSubmit = (data: SetPasswordValues) => completeNewPassword(data.newPassword);

  // After completeNewPassword fails the reducer transitions to unauthenticated
  // with an error message.
  const authError = state.status === 'unauthenticated' ? state.error : undefined;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Imposta una nuova password</CardTitle>
          <CardDescription>Al primo accesso devi scegliere una password personale.</CardDescription>
        </CardHeader>
        <CardContent>
          {authError && (
            <div
              role="alert"
              className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            >
              {authError}
            </div>
          )}
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="newPassword">Nuova password</Label>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                {...register('newPassword')}
              />
              {errors.newPassword && (
                <p className="text-sm text-destructive">{errors.newPassword.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword">Conferma password</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                {...register('confirmPassword')}
              />
              {errors.confirmPassword && (
                <p className="text-sm text-destructive">{errors.confirmPassword.message}</p>
              )}
            </div>
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Salvataggio...' : 'Salva password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

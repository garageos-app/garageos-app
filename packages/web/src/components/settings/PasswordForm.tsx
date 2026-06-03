import { useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changePasswordFormSchema, type ChangePasswordFormValues } from '@/lib/validators/password';
import {
  useChangePassword,
  notifyPasswordChanged,
  type ChangePasswordCode,
} from '@/queries/changePassword';
import { useAuth } from '@/auth/useAuth';

interface Props {
  // Lift the form API to the parent (Settings page) so it can read
  // formState.isDirty to gate the cross-tab dirty AlertDialog.
  formRef?: (form: UseFormReturn<ChangePasswordFormValues>) => void;
}

const TOAST_FOR_CODE: Partial<Record<ChangePasswordCode, string>> = {
  rate_limited: 'Troppi tentativi, riprova tra qualche minuto.',
  not_authenticated: "Sessione scaduta. Effettua di nuovo l'accesso.",
  unknown: 'Impossibile contattare il server. Riprova.',
};

export function PasswordForm({ formRef }: Props) {
  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    formRef?.(form);
  }, [form, formRef]);

  const { mutate, isPending } = useChangePassword();
  const { getIdToken } = useAuth();

  async function onSubmit(values: ChangePasswordFormValues) {
    const result = await mutate(values.oldPassword, values.newPassword);
    if (result.ok) {
      // Best-effort backend audit (BR-280) via raw fetch — never blocks or
      // alters the success UX (no apiFetch → no onAuthExpired/signOut on 401).
      void getIdToken()
        .then((t) => notifyPasswordChanged(t))
        .catch(() => {});
      toast.success('Password aggiornata.');
      form.reset();
      return;
    }
    if (result.code === 'wrong_old_password') {
      form.setError('oldPassword', { message: 'Password attuale non corretta' });
      return;
    }
    if (result.code === 'password_too_weak') {
      form.setError('newPassword', { message: 'La password non rispetta i requisiti' });
      return;
    }
    toast.error(TOAST_FOR_CODE[result.code] ?? 'Impossibile contattare il server. Riprova.');
  }

  const { isDirty } = form.formState;

  return (
    <div className="max-w-xl">
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="oldPassword">Password attuale</Label>
          <Input id="oldPassword" type="password" {...form.register('oldPassword')} />
          {form.formState.errors.oldPassword && (
            <p className="text-sm text-red-600">{form.formState.errors.oldPassword.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="newPassword">Nuova password</Label>
          <Input id="newPassword" type="password" {...form.register('newPassword')} />
          <p className="text-xs text-muted-foreground">
            Almeno 10 caratteri, una maiuscola, una minuscola, un numero.
          </p>
          {form.formState.errors.newPassword && (
            <p className="text-sm text-red-600">{form.formState.errors.newPassword.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Conferma nuova password</Label>
          <Input id="confirmPassword" type="password" {...form.register('confirmPassword')} />
          {form.formState.errors.confirmPassword && (
            <p className="text-sm text-red-600">{form.formState.errors.confirmPassword.message}</p>
          )}
        </div>

        <Button type="submit" disabled={!isDirty || isPending}>
          {isPending ? 'Aggiornamento...' : 'Cambia password'}
        </Button>
      </form>
    </div>
  );
}

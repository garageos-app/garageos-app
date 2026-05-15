import { useEffect } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useProfileUpdate, type ProfileUpdateBody } from '@/queries/profileUpdate';
import type { ProfileMeDto } from '@/queries/profileMe';
import {
  profileFormSchema,
  type ProfileFormValues,
  type ProfileFormParsed,
} from '@/lib/validators/profile';
import { AvatarSection } from './AvatarSection';

interface Props {
  profile: ProfileMeDto;
  // Lifts the form API to the parent (Settings page) so it can read
  // formState.isDirty to gate the cross-tab dirty AlertDialog.
  formRef?: (form: UseFormReturn<ProfileFormValues, unknown, ProfileFormParsed>) => void;
}

function buildDiff(
  values: { firstName: string; lastName: string; phone: string | null },
  dirty: Partial<Record<keyof ProfileFormValues, boolean | undefined>>,
): ProfileUpdateBody {
  const diff: ProfileUpdateBody = {};
  if (dirty.firstName) diff.firstName = values.firstName;
  if (dirty.lastName) diff.lastName = values.lastName;
  if (dirty.phone) diff.phone = values.phone;
  return diff;
}

export function ProfileForm({ profile, formRef }: Props) {
  const form = useForm<ProfileFormValues, unknown, ProfileFormParsed>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone ?? '',
    },
  });

  useEffect(() => {
    formRef?.(form as UseFormReturn<ProfileFormValues, unknown, ProfileFormParsed>);
  }, [form, formRef]);

  const mutation = useProfileUpdate();

  async function onSubmit(values: ProfileFormParsed) {
    const diff = buildDiff(values, form.formState.dirtyFields);
    if (Object.keys(diff).length === 0) return;
    try {
      const updated = await mutation.mutateAsync(diff);
      form.reset({
        firstName: updated.firstName,
        lastName: updated.lastName,
        phone: updated.phone ?? '',
      });
    } catch {
      // toast already shown by mutation onError
    }
  }

  const { isDirty } = form.formState;

  return (
    <div className="max-w-xl">
      <AvatarSection profile={profile} />
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="firstName">Nome</Label>
          <Input id="firstName" {...form.register('firstName')} />
          {form.formState.errors.firstName && (
            <p className="text-sm text-red-600">{form.formState.errors.firstName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="lastName">Cognome</Label>
          <Input id="lastName" {...form.register('lastName')} />
          {form.formState.errors.lastName && (
            <p className="text-sm text-red-600">{form.formState.errors.lastName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="phone">Telefono</Label>
          <Input id="phone" {...form.register('phone')} placeholder="+39 ..." />
          {form.formState.errors.phone && (
            <p className="text-sm text-red-600">{form.formState.errors.phone.message}</p>
          )}
        </div>

        <Button type="submit" disabled={!isDirty || mutation.isPending}>
          {mutation.isPending ? 'Salvataggio...' : 'Salva'}
        </Button>
      </form>
    </div>
  );
}

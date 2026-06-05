import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/useAuth';
import { useMe, useUpdateMeProfile } from '@/queries/me';
import { ProfileForm, type ProfileFormResult } from '@/components/ProfileForm';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { UpdateMeProfileBody } from '@/lib/types/profile';
import { colors, spacing } from '@/theme/colors';

export default function ProfileScreen() {
  const { signOut } = useAuth();
  const me = useMe();
  const update = useUpdateMeProfile();
  const [editing, setEditing] = useState(false);

  async function onSubmit(body: UpdateMeProfileBody): Promise<ProfileFormResult> {
    try {
      await update.mutateAsync(body);
      setEditing(false);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  if (me.isLoading) return <LoadingState variant="fullscreen" />;
  if (me.isError) {
    const code = me.error instanceof ApiError ? me.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={me.refetch} />;
  }

  const p = me.data!;

  if (editing) {
    return (
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <ProfileForm
          initial={{ firstName: p.firstName, lastName: p.lastName, phone: p.phone ?? '' }}
          onSubmit={onSubmit}
          onCancel={() => setEditing(false)}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body}>
      <View style={styles.card}>
        <Text style={styles.label}>Nome</Text>
        <Text style={styles.value}>
          {p.firstName} {p.lastName}
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{p.email}</Text>
        <Text style={styles.hint}>Non modificabile</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Telefono</Text>
        <Text style={styles.value}>{p.phone ?? '—'}</Text>
      </View>

      <Pressable
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
      >
        <Text style={styles.editBtnText}>Modifica</Text>
      </Pressable>

      <Pressable
        onPress={() => void signOut()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
      >
        <Text style={styles.signOutText}>Esci</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  label: { fontSize: 12, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 16, color: colors.fg },
  hint: { fontSize: 12, color: colors.muted, fontStyle: 'italic' },
  editBtn: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  editBtnPressed: { opacity: 0.7 },
  editBtnText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  signOut: {
    marginTop: spacing.md,
    backgroundColor: colors.danger,
    padding: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  signOutPressed: { opacity: 0.8 },
  signOutText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});

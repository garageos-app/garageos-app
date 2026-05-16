import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ResetPasswordForm, type ResetPasswordPayload } from '@/components/auth/ResetPasswordForm';
import { confirmForgotPassword, forgotPasswordRequest } from '@/lib/cognito';
import { colors } from '@/theme/colors';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const initialEmail = typeof params.email === 'string' && params.email ? params.email : null;

  async function handleSubmit(payload: ResetPasswordPayload) {
    const result = await confirmForgotPassword(payload.email, payload.code, payload.newPassword);
    if (!result.ok) return result;
    router.replace({ pathname: '/login', params: { reset: '1' } });
    return { ok: true as const };
  }

  async function handleResend(email: string) {
    const result = await forgotPasswordRequest(email);
    if (!result.ok) return result;
    return { ok: true as const };
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ResetPasswordForm
            initialEmail={initialEmail}
            onSubmit={handleSubmit}
            onResend={handleResend}
            onNavigateBack={() => router.replace('/login')}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center' },
});

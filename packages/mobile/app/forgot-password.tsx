import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';
import { forgotPasswordRequest } from '@/lib/cognito';
import { colors } from '@/theme/colors';

export default function ForgotPasswordScreen() {
  const router = useRouter();

  async function handleSubmit(email: string) {
    const result = await forgotPasswordRequest(email);
    if (!result.ok) return result;
    router.push({
      pathname: '/reset-password',
      params: { email },
    });
    return { ok: true as const };
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ForgotPasswordForm onSubmit={handleSubmit} onNavigateBack={() => router.back()} />
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

import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { SignupForm, type SignupFormPayload } from '@/components/auth/SignupForm';
import { signupCustomer } from '@/queries/signup';
import { colors } from '@/theme/colors';

export default function Signup() {
  const { signIn } = useAuth();
  const router = useRouter();

  async function handleSubmit(payload: SignupFormPayload) {
    const result = await signupCustomer(payload);
    if (!result.ok) {
      return result;
    }
    try {
      await signIn(payload.email, payload.password);
      router.replace({
        pathname: '/verify-email-sent',
        params: { email: payload.email },
      });
    } catch {
      // Signup succeeded server-side but Cognito SRP failed (eventual
      // consistency or transient). Tell the user to log in manually.
      router.replace('/login');
    }
    return { ok: true as const };
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <SignupForm onSubmit={handleSubmit} onNavigateLogin={() => router.back()} />
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

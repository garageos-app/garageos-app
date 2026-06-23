// Hook that encapsulates the device-level push-enable flow (F-CLI-302).
// Extracted from notification-preferences.tsx so it can be reused by the
// push-prompt banner (Task 4) and the push-prompt modal (Task 5).
import { ensurePushPermission, getDevicePushToken, buildRegistrationPayload } from '@/lib/push';
import { useRegisterPushToken } from '@/queries/pushTokens';
import { useInvalidatePushPermission } from '@/queries/pushPermission';
import type { PushPermission } from '@/lib/types/push';

export function useEnablePush(): { enable: () => Promise<PushPermission> } {
  const register = useRegisterPushToken();
  const invalidate = useInvalidatePushPermission();

  const enable = async (): Promise<PushPermission> => {
    const perm = await ensurePushPermission();

    // 'granted' only: acquire the device token and register it server-side.
    // Registration is best-effort — a failure must not prevent the caller from
    // knowing the OS permission result. Note: writePushTokenId is NOT called
    // here; useRegisterPushToken.onSuccess already persists the id.
    if (perm === 'granted') {
      try {
        const token = await getDevicePushToken();
        await register.mutateAsync(buildRegistrationPayload(token));
      } catch {
        // best-effort — swallow registration errors
      }
    }

    // Always invalidate so usePushPermissionStatus reflects the new OS state.
    await invalidate();

    return perm;
  };

  return { enable };
}

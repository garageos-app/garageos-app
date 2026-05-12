import { useAuth } from './useAuth';
import type { UserRole } from './AuthContext';

/**
 * Returns true when the authenticated user has the given role.
 *
 * Use for pre-emptive UI gating ONLY — backend remains authoritative
 * and returns 403 on stale tokens. See BR-066 (cancel intervento
 * requires super_admin) for the canonical consumer.
 */
export function useHasRole(role: UserRole): boolean {
  const { state } = useAuth();
  return state.status === 'authenticated' && state.user.role === role;
}

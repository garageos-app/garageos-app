// getInitials returns the user's initials for fallback avatar display.
// "Mario", "Rossi" → "MR". Single name → single letter. Empty → "?".
export function getInitials(firstName: string, lastName: string): string {
  const f = firstName.trim();
  const l = lastName.trim();
  if (!f && !l) return '?';
  if (!f) return l[0]!.toUpperCase();
  if (!l) return f[0]!.toUpperCase();
  return (f[0]! + l[0]!).toUpperCase();
}

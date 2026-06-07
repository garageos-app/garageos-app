// Display label for a customer row. Business customers show their
// businessName; otherwise (and as a fallback when a business row has no
// businessName) show "Cognome Nome" — the order officina staff scan by.
export function customerDisplayName(c: {
  isBusiness: boolean;
  businessName: string | null;
  firstName: string;
  lastName: string;
}): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return `${c.lastName} ${c.firstName}`;
}

// Copy for the VIN-checksum confirm dialog, shared by the vehicle-create
// form (VehicleCreate.tsx) and the certify flow (CertifyVehicleDialog.tsx).
// BR-001: the ISO 3779 checksum is advisory — a mismatch is common on EU
// VINs — so the dialog frames it as a confirmable warning, never a hard
// "storico/agricolo" rejection. Kept in one place so the two screens can
// never drift.
export const VIN_CHECKSUM_DIALOG_TITLE = 'Controlla il numero di telaio';

export const VIN_CHECKSUM_DIALOG_DESCRIPTION =
  'La cifra di controllo del VIN non corrisponde allo standard ISO 3779 — comune sui veicoli europei. Verifica il telaio sul libretto: se è corretto, conferma per procedere.';

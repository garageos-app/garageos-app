// F-OFF-004 invitation magic-link email. Italian.
// Mirror structure of verify-email-template.ts (escape user-controlled
// fields, plain text fallback, magic-link clear and prominent).

import type { UserRole } from '../../middleware/tenant-context.js';

const ROLE_LABEL_IT: Record<UserRole, string> = {
  super_admin: 'Amministratore',
  mechanic: 'Meccanico',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface InviteUserTemplateArgs {
  invitedFirstName: string;
  invitedByName: string;
  tenantName: string;
  role: UserRole;
  magicLinkUrl: string;
}

export function renderInviteUserHtml(args: InviteUserTemplateArgs): string {
  const roleLabel = ROLE_LABEL_IT[args.role];
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: auto; padding: 24px;">
  <h1 style="font-size: 22px;">Ciao ${escapeHtml(args.invitedFirstName)},</h1>
  <p>${escapeHtml(args.invitedByName)} ti ha invitato a unirti a <strong>${escapeHtml(args.tenantName)}</strong> su GarageOS come <strong>${escapeHtml(roleLabel)}</strong>.</p>
  <p>Clicca il pulsante qui sotto per impostare la tua password e iniziare:</p>
  <p style="margin: 32px 0;">
    <a href="${escapeHtml(args.magicLinkUrl)}" style="display: inline-block; padding: 12px 24px; background: #1f7ae0; color: white; text-decoration: none; border-radius: 6px;">Accetta l'invito</a>
  </p>
  <p style="color: #666; font-size: 13px;">Il link scade tra 7 giorni. Se non l'hai richiesto tu, ignora questa email.</p>
  <p style="color: #666; font-size: 13px;">Oppure copia e incolla questo link nel browser:<br><span style="word-break: break-all;">${escapeHtml(args.magicLinkUrl)}</span></p>
</body></html>`;
}

export function renderInviteUserText(args: InviteUserTemplateArgs): string {
  const roleLabel = ROLE_LABEL_IT[args.role];
  return `Ciao ${args.invitedFirstName},

${args.invitedByName} ti ha invitato a unirti a ${args.tenantName} su GarageOS come ${roleLabel}.

Apri questo link per impostare la tua password:
${args.magicLinkUrl}

Il link scade tra 7 giorni. Se non l'hai richiesto tu, ignora questa email.

— GarageOS`;
}

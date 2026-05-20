import { describe, it, expect } from 'vitest';
import {
  renderInviteUserHtml,
  renderInviteUserText,
} from '../../../../src/lib/email/invite-user-template.js';

describe('invite-user-template', () => {
  const args = {
    invitedFirstName: 'Mario',
    invitedByName: 'Giuseppe Bianchi',
    tenantName: 'Officina Giuseppe',
    role: 'mechanic' as const,
    magicLinkUrl: 'https://app.garageos.aifollyadvisor.com/invitations/abc123',
  };

  it('renders HTML with all key fields + link', () => {
    const html = renderInviteUserHtml(args);
    expect(html).toContain('Mario');
    expect(html).toContain('Giuseppe Bianchi');
    expect(html).toContain('Officina Giuseppe');
    expect(html).toContain('https://app.garageos.aifollyadvisor.com/invitations/abc123');
    expect(html.toLowerCase()).toContain('meccanico');
  });

  it('renders text with all key fields + link', () => {
    const text = renderInviteUserText(args);
    expect(text).toContain('Mario');
    expect(text).toContain('Officina Giuseppe');
    expect(text).toContain('https://app.garageos.aifollyadvisor.com/invitations/abc123');
  });

  it('translates super_admin role label correctly', () => {
    const html = renderInviteUserHtml({ ...args, role: 'super_admin' });
    expect(html.toLowerCase()).toContain('amministratore');
  });
});

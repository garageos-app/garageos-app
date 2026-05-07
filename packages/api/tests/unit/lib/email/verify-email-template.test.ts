import { describe, expect, it } from 'vitest';

import {
  renderVerifyEmailHtml,
  renderVerifyEmailText,
} from '../../../../src/lib/email/verify-email-template.js';

describe('verify-email template', () => {
  const URL = 'https://app.garageos.aifollyadvisor.com/verify-email?token=abc-123';

  it('text contains customerName and verificationUrl', () => {
    const text = renderVerifyEmailText('Mario', URL);
    expect(text).toContain('Mario');
    expect(text).toContain(URL);
    expect(text).toContain('24 ore');
  });

  it('html contains escaped customerName (XSS hardening)', () => {
    const html = renderVerifyEmailHtml('<script>alert(1)</script>', URL);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('html contains the verificationUrl twice (CTA + plain copy fallback)', () => {
    const html = renderVerifyEmailHtml('Mario', URL);
    const occurrences = html.split(URL).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('html contains the expected GarageOS branding markers', () => {
    const html = renderVerifyEmailHtml('Mario', URL);
    expect(html).toContain('Benvenuto in GarageOS');
    expect(html).toMatch(/Conferma email|Verifica email/);
    expect(html).toContain('app.garageos.aifollyadvisor.com');
  });
});

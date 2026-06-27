import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { WebCertStack } from '../lib/stacks/web-cert-stack.js';

describe('WebCertStack', () => {
  function buildStack(): WebCertStack {
    const app = new cdk.App();
    return new WebCertStack(app, 'TestWebCertStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      crossRegionReferences: true,
      domainName: 'example.com',
      subdomain: 'app',
      synthMock: true,
    });
  }

  it('is deployed in us-east-1 (CloudFront cert region requirement)', () => {
    const stack = buildStack();
    expect(stack.region).toBe('us-east-1');
  });

  it('provisions exactly one ACM certificate for app.<domain> with DNS validation', () => {
    const stack = buildStack();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'app.example.com',
      ValidationMethod: 'DNS',
    });
  });

  it('exposes the appCertificate publicly for cross-region consumption', () => {
    const stack = buildStack();
    expect(stack.appCertificate).toBeDefined();
    expect(stack.appCertificate.certificateArn).toBeDefined();
  });
});

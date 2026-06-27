import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { productionConfig } from '../lib/config/production.js';
import { WebStack } from '../lib/stacks/web-stack.js';

describe('WebStack', () => {
  function buildStack(): WebStack {
    const app = new cdk.App();
    // Cross-region cert is supplied as an ICertificate by reference.
    // In the real bin entry it comes from WebCertStack via
    // `crossRegionReferences: true`; the test substitutes a fromArn
    // import so the stack synth stays self-contained.
    const certHostStack = new cdk.Stack(app, 'CertHost', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const cert = acm.Certificate.fromCertificateArn(
      certHostStack,
      'AppCert',
      'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
    );

    return new WebStack(app, 'TestWebStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
      crossRegionReferences: true,
      config: { ...productionConfig, synthMock: true },
      subdomain: productionConfig.appSubdomain,
      bucketName: productionConfig.webBucketName,
      appCertificate: cert,
    });
  }

  it('is deployed in eu-central-1 (same region as MainStack)', () => {
    const stack = buildStack();
    expect(stack.region).toBe('eu-central-1');
  });

  it('exposes the four CfnOutputs documented in the spec', () => {
    const stack = buildStack();
    const template = Template.fromStack(stack);
    template.hasOutput('WebBucketName', {});
    template.hasOutput('CloudFrontDistributionId', {});
    template.hasOutput('CloudFrontDomainName', {});
    template.hasOutput('AppUrl', {
      Value: 'https://app.garageos.aifollyadvisor.com',
    });
  });

  it('passes the configured bucket name through to the bucket', () => {
    const stack = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: productionConfig.webBucketName,
    });
  });

  it('passes the configured app subdomain through to the distribution alias', () => {
    const stack = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['app.garageos.aifollyadvisor.com'],
      }),
    });
  });
});

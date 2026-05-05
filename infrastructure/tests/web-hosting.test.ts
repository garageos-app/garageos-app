import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { WebHostingConstruct } from '../lib/constructs/web-hosting.js';

describe('WebHostingConstruct', () => {
  function buildTemplate(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestWebStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'TestZone', {
      hostedZoneId: 'Z00000000000000000000',
      zoneName: 'example.com',
    });
    const cert = acm.Certificate.fromCertificateArn(
      stack,
      'TestCert',
      'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
    );
    new WebHostingConstruct(stack, 'WebHosting', {
      bucketName: 'test-web-bucket',
      hostedZone,
      appCertificate: cert,
      appDomain: 'app.example.com',
    });
    return Template.fromStack(stack);
  }
  const template = buildTemplate();

  it('provisions exactly one S3 bucket with the expected name', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-web-bucket',
    });
  });

  it('blocks all public access on the web bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('enforces S3-managed AES256 encryption on the web bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      },
    });
  });

  it('does NOT enable static website hosting on the bucket (CloudFront-only access)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: Match.absent(),
    });
  });

  it('uses RETAIN as removal policy (consistent with StorageConstruct)', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('provisions a CloudFront distribution with HTTPS redirect and the app subdomain alias', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['app.example.com'],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          Compress: true,
        }),
        DefaultRootObject: 'index.html',
        PriceClass: 'PriceClass_100',
      }),
    });
  });

  it('configures SPA fallback (403 and 404 → 200 /index.html)', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 0,
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 0,
          }),
        ]),
      }),
    });
  });

  it('uses Origin Access Control (modern), not the deprecated Origin Access Identity', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
  });

  it('provisions Route 53 A and AAAA alias records pointing to the distribution', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'app.example.com.',
      AliasTarget: Match.objectLike({
        DNSName: Match.anyValue(),
      }),
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'app.example.com.',
    });
  });
});

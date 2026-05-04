import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { StorageConstruct } from '../lib/constructs/storage.js';

describe('StorageConstruct', () => {
  function buildTemplate(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStorageStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new StorageConstruct(stack, 'Storage', {
      environment: 'production',
      corsAllowedOrigins: [
        'https://app.garageos.aifollyadvisor.com',
        'https://garageos.aifollyadvisor.com',
      ],
    });
    return Template.fromStack(stack);
  }

  it('provisions exactly one S3 bucket with the expected name', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'garageos-production-attachments',
    });
  });

  it('enforces server-side encryption (S3-managed AES256)', () => {
    const template = buildTemplate();
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

  it('blocks all public access', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('enables object versioning', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('configures CORS with 2 allowed origins (app + apex), GET+PUT methods', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(['GET', 'PUT']),
            AllowedOrigins: [
              'https://app.garageos.aifollyadvisor.com',
              'https://garageos.aifollyadvisor.com',
            ],
            AllowedHeaders: ['*'],
            MaxAge: 3000,
          }),
        ]),
      },
    });
  });

  it('configures lifecycle rule: transition to IA after 90 days + noncurrent expiry 30d', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'transition-to-ia',
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: 'STANDARD_IA',
                TransitionInDays: 90,
              }),
            ]),
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }),
        ]),
      },
    });
  });

  it('configures lifecycle rule: abort incomplete uploads after 7 days', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'abort-incomplete-uploads',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      },
    });
  });

  it('retains the bucket on stack deletion', () => {
    const template = buildTemplate();
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

#!/usr/bin/env node
import 'source-map-support/register.js';

import * as cdk from 'aws-cdk-lib';

import { productionConfig } from '../lib/config/production.js';
import { MainStack } from '../lib/stacks/main-stack.js';
import { OidcStack } from '../lib/stacks/oidc-stack.js';
import { WebCertStack } from '../lib/stacks/web-cert-stack.js';
import { WebStack } from '../lib/stacks/web-stack.js';

// CDK app entry. CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION are
// provided by the AWS CLI / GitHub Actions runner via the assumed
// role. For CI synth-only runs (CDK_SYNTH_MOCK=true) the values may
// be absent and the env block falls back to undefined — synth still
// works because the production config sets synthMock=true and DNS
// lookups are short-circuited.

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'eu-central-1';

new OidcStack(app, 'GarageosOidcStack', {
  env: { account, region },
  githubOrg: 'garageos-app',
  githubRepo: 'garageos-app',
  description: 'GitHub Actions OIDC trust (deploy once before MainStack)',
});

new MainStack(app, 'GarageosMainStack', {
  env: { account, region },
  config: productionConfig,
  description: 'GarageOS production stack (PR 21 minimum: DNS + Secrets + Lambda + APIGW)',
  tags: {
    Environment: 'production',
    Project: 'garageos',
    ManagedBy: 'cdk',
  },
});

const webCertStack = new WebCertStack(app, 'GarageosWebCertStack', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  domainName: productionConfig.domainName,
  appSubdomain: productionConfig.appSubdomain,
  synthMock: productionConfig.synthMock,
  description: 'GarageOS ACM cert for web app (us-east-1, required by CloudFront)',
  tags: {
    Environment: 'production',
    Project: 'garageos',
    ManagedBy: 'cdk',
  },
});

new WebStack(app, 'GarageosWebStack', {
  env: { account, region },
  crossRegionReferences: true,
  config: productionConfig,
  appCertificate: webCertStack.appCertificate,
  description: 'GarageOS web hosting (S3 + CloudFront + Route53 alias for app subdomain)',
  tags: {
    Environment: 'production',
    Project: 'garageos',
    ManagedBy: 'cdk',
  },
});

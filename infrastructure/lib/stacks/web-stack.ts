import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { WebHostingConstruct } from '../constructs/web-hosting.js';
import { type EnvironmentConfig } from '../config/production.js';

// Web hosting stack (eu-central-1) — wraps WebHostingConstruct and
// exposes operational outputs (bucket name + distribution id) that
// the deploy-web.yml workflow consumes via
// `aws cloudformation describe-stacks`.
//
// The ACM certificate is supplied as a prop from WebCertStack
// (us-east-1). Cross-region wiring is enabled via
// `crossRegionReferences: true` on the StackProps in bin/garageos.ts.

export interface WebStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly appCertificate: acm.ICertificate;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { config } = props;
    const appDomain = `${config.appSubdomain}.${config.domainName}`;

    const hostedZone: route53.IHostedZone = config.synthMock
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: 'Z00000000000000000000',
          zoneName: config.domainName,
        })
      : route53.HostedZone.fromLookup(this, 'HostedZone', {
          domainName: config.domainName,
        });

    const webHosting = new WebHostingConstruct(this, 'WebHosting', {
      bucketName: config.webBucketName,
      hostedZone,
      appCertificate: props.appCertificate,
      appDomain,
    });

    new cdk.CfnOutput(this, 'WebBucketName', {
      value: webHosting.webBucket.bucketName,
      description: 'S3 bucket name (consumed by deploy-web.yml asset sync)',
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: webHosting.distribution.distributionId,
      description: 'Distribution id (consumed by deploy-web.yml invalidation)',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: webHosting.distribution.distributionDomainName,
      description: 'AWS-generated CloudFront domain (use for smoke before DNS propagation)',
    });
    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${appDomain}`,
    });
  }
}

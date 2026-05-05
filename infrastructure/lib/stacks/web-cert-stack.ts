import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

// ACM certificate for the web app subdomain. Lives in us-east-1
// because CloudFront only accepts certificates from that region.
// The certificate is consumed cross-region by WebStack via
// `crossRegionReferences: true`.
//
// `synthMock` mirrors DnsConstruct: hosted-zone lookup is replaced
// with a synthetic stub for offline `cdk synth` (CI gate).

export interface WebCertStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly appSubdomain: string;
  readonly synthMock: boolean;
}

export class WebCertStack extends cdk.Stack {
  public readonly appCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: WebCertStackProps) {
    super(scope, id, props);

    const hostedZone: route53.IHostedZone = props.synthMock
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: 'Z00000000000000000000',
          zoneName: props.domainName,
        })
      : route53.HostedZone.fromLookup(this, 'HostedZone', {
          domainName: props.domainName,
        });

    this.appCertificate = new acm.Certificate(this, 'AppCert', {
      domainName: `${props.appSubdomain}.${props.domainName}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
  }
}

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

// Hosted zone + ACM cert for api.<domain>. Hosted zone is read via
// fromLookup in production (requires the domain to be already
// registered + propagated). In CI synth, `synthMock` short-circuits
// to fromHostedZoneAttributes with synthetic values so cdk synth
// runs offline.
//
// No appCertificate in PR 21 — the web-app S3+CloudFront stack
// (PR 25) will own that.

export interface DnsConstructProps {
  readonly domainName: string;
  readonly apiSubdomain: string;
  readonly synthMock: boolean;
}

export class DnsConstruct extends Construct {
  public readonly hostedZone: route53.IHostedZone;
  public readonly apiCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsConstructProps) {
    super(scope, id);

    if (props.synthMock) {
      // Synthetic hosted zone for offline cdk synth. The values are
      // arbitrary — the resulting template never gets deployed.
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: 'Z00000000000000000000',
        zoneName: props.domainName,
      });
    } else {
      this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: props.domainName,
      });
    }

    this.apiCertificate = new acm.Certificate(this, 'ApiCert', {
      domainName: `${props.apiSubdomain}.${props.domainName}`,
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });
  }
}

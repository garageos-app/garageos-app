import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';

// SES domain identity + configuration set + IAM grant helper.
// DKIM CNAMEs are auto-published into the hosted zone via
// ses.Identity.publicHostedZone (RSA_2048 EASY_DKIM, default).
//
// Sandbox vs production: account-level state, NOT controlled by CDK.
// The construct ships identical resources either way. The operator
// runbook in infrastructure/README.md (F-section verify-email)
// requests production access manually post-merge.

export interface SesConstructProps {
  readonly hostedZone: route53.IHostedZone;
  readonly emailFromDomain: string;
  readonly configurationSetName: string;
}

export class SesConstruct extends Construct {
  public readonly emailIdentity: ses.EmailIdentity;
  public readonly configurationSet: ses.ConfigurationSet;
  public readonly identityArn: string;
  public readonly configurationSetArn: string;

  constructor(scope: Construct, id: string, props: SesConstructProps) {
    super(scope, id);

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: props.configurationSetName,
      reputationMetrics: true,
      sendingEnabled: true,
    });

    this.emailIdentity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(props.hostedZone),
      configurationSet: this.configurationSet,
    });

    // Build literal ARNs (no Token resolution). cdk.Stack.formatArn with the
    // default partition emits ${Token[AWS.Partition.N]}, which IAM policies
    // resolve fine at deploy time but breaks tests asserting literal strings.
    // SES is deployed in a partition known at synth (always `aws` for our
    // commercial-region accounts), so use a template literal.
    // See also: feedback_cdk_aws_service_arn_format.md (PR #50).
    const stack = cdk.Stack.of(this);
    this.identityArn = `arn:aws:ses:${stack.region}:${stack.account}:identity/${props.emailFromDomain}`;
    this.configurationSetArn = `arn:aws:ses:${stack.region}:${stack.account}:configuration-set/${props.configurationSetName}`;
  }

  /** Grant ses:SendEmail and ses:SendRawEmail scoped to identity + config set. */
  public grantSendEmail(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resourceArns: [this.identityArn, this.configurationSetArn],
    });
  }
}

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { SesConstruct } from '../lib/constructs/ses.js';

// Helper builds the construct under test. Templates are NOT pre-synthesized
// here — callers that mutate the stack (e.g. attaching a Role for grant tests)
// must call Template.fromStack themselves AFTER all mutations, otherwise
// CDK throws ConstructTreeModifiedAfterSynth.
function buildStack() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '111122223333', region: 'eu-central-1' },
  });
  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
    hostedZoneId: 'Z00000000000000000000',
    zoneName: 'garageos.aifollyadvisor.com',
  });
  const ses = new SesConstruct(stack, 'Ses', {
    hostedZone,
    emailFromDomain: 'garageos.aifollyadvisor.com',
    configurationSetName: 'garageos-production',
  });
  return { stack, ses };
}

describe('SesConstruct', () => {
  it('builds the identity ARN with the expected service/region/account/resource format', () => {
    const { ses } = buildStack();
    expect(ses.identityArn).toBe(
      'arn:aws:ses:eu-central-1:111122223333:identity/garageos.aifollyadvisor.com',
    );
  });

  it('creates a ConfigurationSet named garageos-production with reputation metrics', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: 'garageos-production',
      ReputationOptions: { ReputationMetricsEnabled: true },
      SendingOptions: { SendingEnabled: true },
    });
  });

  it('creates an EmailIdentity bound to garageos.aifollyadvisor.com', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    // ConfigurationSetName is rendered as a Ref to the same-stack
    // ConfigurationSet — assert structurally rather than as a literal string.
    template.hasResourceProperties(
      'AWS::SES::EmailIdentity',
      Match.objectLike({
        EmailIdentity: 'garageos.aifollyadvisor.com',
        ConfigurationSetAttributes: {
          ConfigurationSetName: Match.objectLike({ Ref: Match.stringLikeRegexp('SesConfigSet') }),
        },
      }),
    );
  });

  it('auto-creates 3 DKIM CNAME records in the hosted zone', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Route53::RecordSet', 3);
    // The DKIM record Name is a Fn::GetAtt token resolved at deploy time
    // (SES generates the *._domainkey.<domain> selectors), so we cannot
    // regex-match the Name property. Assert on the static fields we DO
    // control: Type=CNAME and HostedZoneId bound to our zone.
    const recordSets = template.findResources('AWS::Route53::RecordSet');
    const cnames = Object.values(recordSets).filter(
      (r) => r.Properties.Type === 'CNAME' && r.Properties.HostedZoneId === 'Z00000000000000000000',
    );
    expect(cnames).toHaveLength(3);
    for (const r of cnames) {
      // Each Name must be a Fn::GetAtt to the EmailIdentity's DkimDNSTokenName{1,2,3}
      const name = r.Properties.Name as { 'Fn::GetAtt': [string, string] };
      expect(name['Fn::GetAtt']).toBeDefined();
      expect(name['Fn::GetAtt'][0]).toContain('SesDomainIdentity');
      expect(name['Fn::GetAtt'][1]).toMatch(/^DkimDNSTokenName[123]$/);
    }
  });

  it('grantSendEmail produces an IAM policy with action ses:SendEmail and ses:SendRawEmail', () => {
    const { stack, ses } = buildStack();
    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    ses.grantSendEmail(role);
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  it('grantSendEmail scopes Resource to identity + config set ARNs (no Resource: *)', () => {
    const { stack, ses } = buildStack();
    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    ses.grantSendEmail(role);
    const tpl = Template.fromStack(stack);
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sesPolicy = Object.values(policies).find((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes('ses:SendEmail'),
    );
    expect(sesPolicy).toBeDefined();
    const stmt = (
      sesPolicy!.Properties.PolicyDocument as { Statement: { Resource: string[] }[] }
    ).Statement.find((s) => Array.isArray(s.Resource));
    expect(stmt!.Resource).toHaveLength(2);
    expect(stmt!.Resource).not.toContain('*');
  });
});

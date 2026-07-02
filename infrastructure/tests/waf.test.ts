import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { WafConstruct } from '../lib/constructs/waf.js';

describe('WafConstruct', () => {
  // CDK Templates are immutable after fromStack — sharing across `it`
  // blocks is safe and avoids re-synthesising the stack N times.
  function buildTemplate(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestWafStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new WafConstruct(stack, 'Waf', {
      environment: 'production',
      ipRequestRateLimit: 2000,
    });
    return Template.fromStack(stack);
  }
  const template = buildTemplate();

  it('provisions exactly one Web ACL with REGIONAL scope and expected name', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Name: 'garageos-production-api-waf',
    });
  });

  it('default action is allow', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      DefaultAction: { Allow: {} },
    });
  });

  it('provisions 3 rules with expected priorities and names', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [
        Match.objectLike({ Name: 'AWS-ManagedRulesCommonRuleSet', Priority: 1 }),
        Match.objectLike({ Name: 'AWS-ManagedRulesKnownBadInputsRuleSet', Priority: 2 }),
        Match.objectLike({ Name: 'RateLimitIp', Priority: 3 }),
      ],
    });
  });

  it('applies AWS managed CommonRuleSet at priority 1 with overrideAction none', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWS-ManagedRulesCommonRuleSet',
          OverrideAction: { None: {} },
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        }),
      ]),
    });
  });

  it('applies AWS managed KnownBadInputsRuleSet at priority 2', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWS-ManagedRulesKnownBadInputsRuleSet',
          OverrideAction: { None: {} },
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        }),
      ]),
    });
  });

  it('rate-limits to 2000 requests per 5min per IP at priority 3 (block action)', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitIp',
          Action: { Block: {} },
          Statement: {
            RateBasedStatement: {
              Limit: 2000,
              AggregateKeyType: 'IP',
            },
          },
        }),
      ]),
    });
  });

  it('enables CloudWatch metrics on the ACL with metricName "GarageosWaf"', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        SampledRequestsEnabled: true,
        MetricName: 'GarageosWaf',
      },
    });
  });
});

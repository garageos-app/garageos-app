import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

// WAFv2 Web ACL REGIONAL scope per API Gateway HTTP API v2
// (eu-central-1). 3 rule da APPENDICE_C §5.8:
// 1. CommonRuleSet — OWASP Top 10 baseline (AWS managed)
// 2. KnownBadInputs — exploit signature pattern (AWS managed)
// 3. RateLimitIp — 2000 req/5min per IP (eventually consistent)
//
// L'association al stage default è creata in MainStack (cross-construct
// composition). CLOUDFRONT scope NON è in scope di questo construct
// (sblocca con CloudFront in PR 25 — cross-region us-east-1).
//
// metricName 'GarageosWaf' allineato a APPENDICE_C §5.8 letterale.
// Per-rule metricName matcha il rule statement name AWS managed
// (`AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`)
// e `RateLimitIp` per il rate-based — tracciamento separato in CloudWatch.

export interface WafConstructProps {
  readonly environment: string;
  /**
   * Max requests per source IP within the WAFv2 rate-based statement
   * sliding window. The window itself is fixed at 5 minutes by the
   * WAFv2 service — not a configurable parameter.
   */
  readonly ipRequestRateLimit: number;
}

export class WafConstruct extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `garageos-${props.environment}-api-waf`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'GarageosWaf',
      },
      rules: [
        {
          name: 'AWS-ManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
          },
        },
        {
          name: 'AWS-ManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        {
          name: 'RateLimitIp',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.ipRequestRateLimit,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'RateLimitIp',
          },
        },
      ],
    });
  }
}

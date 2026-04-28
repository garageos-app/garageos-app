import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

// Public HTTPS ingress: API Gateway HTTP API v2 with custom domain,
// catch-all proxy → Lambda. ~70% cheaper than REST API v1 ($1 vs
// $3.50 per million requests) and sufficient for our case (no usage
// plans, no API keys).
//
// Custom domain is wired entirely in CDK — no manual aws apprunner
// associate-custom-domain step required (that was the v1.0 App
// Runner runtime approach, retired).
//
// Throttling and access logs: tied to the default stage via the
// CfnStage escape hatch because L2 HttpApi doesn't expose those
// properties directly.

export interface ApiGatewayConstructProps {
  readonly apiSubdomain: string;
  readonly domainName: string;
  readonly hostedZone: route53.IHostedZone;
  readonly apiCertificate: acm.ICertificate;
  readonly lambdaFunction: lambda.IFunction;
  readonly throttleBurst: number;
  readonly throttleRate: number;
  readonly logRetentionDays: number;
}

export class ApiGatewayConstruct extends Construct {
  public readonly httpApi: apigw.HttpApi;
  public readonly domainName: apigw.DomainName;
  public readonly accessLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ApiGatewayConstructProps) {
    super(scope, id);

    const fqdn = `${props.apiSubdomain}.${props.domainName}`;

    this.accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: '/aws/apigateway/garageos-api-access',
      retention: this.mapRetention(props.logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.domainName = new apigw.DomainName(this, 'DomainName', {
      domainName: fqdn,
      certificate: props.apiCertificate,
      endpointType: apigw.EndpointType.REGIONAL,
      securityPolicy: apigw.SecurityPolicy.TLS_1_2,
    });

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: 'garageos-api',
      description: 'GarageOS backend (Fastify on Lambda via LWA)',
      corsPreflight: {
        allowOrigins: ['https://app.garageos.it', 'https://garageos.it', 'exp://', 'garageos://'],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id', 'X-Idempotency-Key'],
        exposeHeaders: ['X-Request-Id'],
        maxAge: cdk.Duration.hours(1),
        allowCredentials: false,
      },
      defaultDomainMapping: { domainName: this.domainName },
      disableExecuteApiEndpoint: false,
    });

    const integration = new apigwIntegrations.HttpLambdaIntegration(
      'LambdaIntegration',
      props.lambdaFunction,
      { payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0 },
    );

    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
    });

    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: props.throttleBurst,
        throttlingRateLimit: props.throttleRate,
        detailedMetricsEnabled: true,
      };
      defaultStage.accessLogSettings = {
        destinationArn: this.accessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          responseLength: '$context.responseLength',
          integrationLatency: '$context.integrationLatency',
          userAgent: '$context.identity.userAgent',
        }),
      };
    }

    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: props.hostedZone,
      recordName: props.apiSubdomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          this.domainName.regionalDomainName,
          this.domainName.regionalHostedZoneId,
        ),
      ),
    });
  }

  private mapRetention(days: number): logs.RetentionDays {
    switch (days) {
      case 7:
        return logs.RetentionDays.ONE_WEEK;
      case 14:
        return logs.RetentionDays.TWO_WEEKS;
      case 30:
        return logs.RetentionDays.ONE_MONTH;
      default:
        throw new Error(`Unsupported logRetentionDays: ${days}`);
    }
  }
}

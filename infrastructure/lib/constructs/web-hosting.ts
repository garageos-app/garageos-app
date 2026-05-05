import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

// Static web hosting for the officina demo web app:
//   - Private S3 bucket (no public access, no website hosting),
//     accessed only by CloudFront via Origin Access Control (OAC).
//   - CloudFront distribution with HTTPS redirect, SPA fallback
//     (403/404 → 200 /index.html) for client-side routing, and
//     PriceClass_100 (Europe + North America) for cost.
//   - Route 53 A + AAAA alias records pointing the configured app
//     subdomain at the distribution.
//
// removalPolicy RETAIN on the bucket (consistent with StorageConstruct):
// losing the bucket = losing all deployed asset history. Cleanup must
// be manual via console if ever required.
//
// No CloudFront access logging in PR demo-0 — deferred until traffic
// volume justifies the log retention cost.

export interface WebHostingConstructProps {
  readonly bucketName: string;
  readonly hostedZone: route53.IHostedZone;
  readonly appCertificate: acm.ICertificate;
  readonly appDomain: string;
}

export class WebHostingConstruct extends Construct {
  public readonly webBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebHostingConstructProps) {
    super(scope, id);

    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      domainNames: [props.appDomain],
      certificate: props.appCertificate,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: props.appDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });

    new route53.AaaaRecord(this, 'AliasRecordIpv6', {
      zone: props.hostedZone,
      recordName: props.appDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });
  }
}

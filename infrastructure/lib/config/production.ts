// Production environment configuration for the GarageOS CDK app.
// Single env in v1 — staging is deferred. When staging is added,
// this file becomes one of multiple `<env>.ts` modules selected by
// the bin entry point via process.env.GARAGEOS_ENV.
//
// `synthMock` is set when CDK_SYNTH_MOCK=true is in the environment
// (CI gate). When true, DnsConstruct skips Route53 hosted-zone
// lookups (which require AWS account context) and uses synthetic
// values so `cdk synth` succeeds offline.

export interface EnvironmentConfig {
  readonly environment: 'production';
  readonly domainName: string;
  readonly apiSubdomain: string;
  readonly appSubdomain: string;
  readonly emailFromDomain: string;
  readonly emailFromAddress: string;
  readonly webBucketName: string;
  readonly lambda: {
    readonly memoryMb: number;
    readonly architecture: 'arm64' | 'x86_64';
    readonly timeoutSec: number;
    readonly reservedConcurrency: number;
  };
  readonly apiGateway: {
    readonly throttleBurst: number;
    readonly throttleRate: number;
  };
  readonly cognito: {
    readonly mfaTotpEnabled: boolean;
  };
  readonly waf: {
    readonly ipRequestRateLimit: number;
  };
  readonly logRetentionDays: number;
  readonly synthMock: boolean;
}

export const productionConfig: EnvironmentConfig = {
  environment: 'production',
  domainName: 'garageos.aifollyadvisor.com',
  apiSubdomain: 'api',
  appSubdomain: 'app',
  emailFromDomain: 'garageos.aifollyadvisor.com',
  emailFromAddress: 'noreply@garageos.aifollyadvisor.com',
  webBucketName: 'garageos-production-web',
  lambda: {
    memoryMb: 1024,
    architecture: 'arm64',
    timeoutSec: 30,
    reservedConcurrency: 100,
  },
  apiGateway: {
    throttleBurst: 200,
    throttleRate: 100,
  },
  cognito: {
    mfaTotpEnabled: true,
  },
  waf: {
    ipRequestRateLimit: 2000,
  },
  logRetentionDays: 7,
  synthMock: process.env.CDK_SYNTH_MOCK === 'true',
};

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// Federated trust enabling GitHub Actions to assume an IAM role via
// short-lived OIDC tokens — no static AWS access keys committed in
// repo secrets. Deployed ONCE before the main stack. The CfnOutput
// `DeployRoleArn` is what you copy as the GitHub secret
// AWS_DEPLOY_ROLE_ARN.
//
// Trust policy uses StringLike on `:sub` rather than StringEquals
// to allow any branch / pull_request workflow (v1). v1.1 will tighten
// to a specific branch and switch from PowerUserAccess to a custom
// least-privilege policy.

export interface OidcStackProps extends cdk.StackProps {
  readonly githubOrg: string;
  readonly githubRepo: string;
}

export class OidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: OidcStackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'garageos-github-deploy',
      description: 'Role assumed by GitHub Actions for deployment',
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${props.githubOrg}/${props.githubRepo}:*`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess')],
    });

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Add this ARN to GitHub secrets as AWS_DEPLOY_ROLE_ARN',
    });
  }
}

# Google Sign-In PR 2 Deploy Runbook

## Prerequisite (Operator, Before Deploy)

The Google Cloud OAuth Web client already exists (project `garageos-b09f3`, redirect `https://garageos-production-clienti.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse`). Create the Secrets Manager secret holding its credentials:

```bash
aws secretsmanager create-secret \
  --name garageos/production/google-oauth \
  --description "Google OAuth client for the clienti Cognito Hosted UI IdP" \
  --secret-string '{"client_id":"<CLIENT_ID>","client_secret":"<CLIENT_SECRET>"}' \
  --region eu-central-1
```

If the secret already exists, update it instead:

```bash
aws secretsmanager put-secret-value \
  --secret-id garageos/production/google-oauth \
  --secret-string '{"client_id":"<CLIENT_ID>","client_secret":"<CLIENT_SECRET>"}' \
  --region eu-central-1
```

**This secret must exist before `cdk deploy`** — CDK resolves the dynamic reference at deploy time; a missing secret fails the deploy.

## Deploy

```bash
pnpm --filter @garageos/infrastructure cdk deploy
```

Note: migrations are operator-driven and unrelated here — no schema change in this PR.

## Post-Deploy Verification

1. Capture `CognitoClientiHostedUiDomain` from the stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name CognitoClientiIdpStack --region eu-central-1 --query 'Stacks[0].Outputs[?OutputKey==`CognitoClientiHostedUiDomain`].OutputValue' --output text
   ```

2. Confirm the Google IdP shows under the clienti pool:
   ```bash
   aws cognito-idp describe-user-pool --user-pool-id <user-pool-id> --region eu-central-1
   aws cognito-idp describe-identity-provider --user-pool-id <user-pool-id> --provider-name Google --region eu-central-1
   ```

3. Confirm both triggers are wired:
   ```bash
   aws cognito-idp describe-user-pool --user-pool-id <user-pool-id> --region eu-central-1 | grep -A 20 LambdaConfig
   ```
   Verify both `PreSignUp` and `PreTokenGeneration` are present.

## Smoke Testing (PR 3 Dependency)

The OAuth browser flow + deep link is verified on a **dev build** in PR 3. Three test cases:
- New Google user
- Returning Google user
- Password→Google account merge

PR 2 ships infrastructure only; CDK synth + infra tests on CI are the gate here. Device smoke is a **PR 3 BLOCKER**, not part of PR 2.

---

**Note:** Cross-reference `--stack-name` against `infrastructure/bin/*.ts` before running (per `feedback_documented_commands_drift`).

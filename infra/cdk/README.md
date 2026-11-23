# infra/cdk

AWS CDK (TypeScript) app for the Cloud-Ops platform. One stack, `CloudOps-<stage>`:

| Piece | Service | Why it's cheap |
|---|---|---|
| Data | DynamoDB, on-demand | Pay per request, $0 when idle. Backups only in prod |
| Auth | Cognito, **Lite** plan | Free tier covers 10,000 monthly users |
| API | API Gateway **HTTP API** + 4 Lambdas | HTTP API is the cheaper flavour; ARM Lambdas; throttled at 20 req/s |
| Logs | CloudWatch Logs | Kept 1 week only |
| Cost alert | AWS Budgets (whole account) | Budgets without actions are free |

There's no VPC, NAT gateway, load balancer or always-on server. Idle cost is about $0. In `dev`, everything is deleted by `cdk destroy`.

## Deploy to your account

Prerequisites: Node 20+, AWS CLI v2 signed in (`aws configure` or `aws sso login`), and a region set (e.g. `ap-south-1`).

```bash
# from the repo root
npm install

cd infra/cdk
npx cdk bootstrap                                      # once per account + region
npx cdk deploy -c budgetEmail=you@example.com          # ~3 minutes
```

Note the outputs: `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `PlatformAccountId`, `PlatformRoleName`.

## Try it end to end (same account as platform and "customer")

```bash
API=<ApiUrl without trailing slash>
POOL=<UserPoolId>
CLIENT=<UserPoolClientId>
EMAIL=you@example.com
PASS='ChooseAStrongPass123'

# 1. Create and confirm a user (dev only: admin-confirm skips the email code)
aws cognito-idp sign-up --client-id $CLIENT --username $EMAIL --password "$PASS" \
  --user-attributes Name=email,Value=$EMAIL
aws cognito-idp admin-confirm-sign-up --user-pool-id $POOL --username $EMAIL

# 2. Get an ID token
TOKEN=$(aws cognito-idp initiate-auth --client-id $CLIENT --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=$EMAIL,PASSWORD="$PASS" \
  --query AuthenticationResult.IdToken --output text)

# 3. First call creates your workspace and shows the onboarding values
curl -s -H "Authorization: Bearer $TOKEN" $API/me

# 4. Create the access role, using the values from /me
aws cloudformation deploy --stack-name cloudops-access-role \
  --template-file ../../onboarding/cloudformation/cloudops-access-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides PlatformAccountId=<platformAccountId> \
    PlatformRoleName=<platformRoleName> ExternalId=<externalId>

# 5. Optional: a test ASG at 0 instances ($0 until you scale it)
aws cloudformation deploy --stack-name cloudops-test-asg \
  --template-file ../test-fixtures/test-asg.yaml \
  --parameter-overrides SubnetIds=<subnet-a>,<subnet-b>

# 6. Connect the account
curl -s -X POST $API/accounts -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"roleArn":"arn:aws:iam::<account>:role/CloudOpsAccessRole","alias":"My account","regions":["ap-south-1"]}'

# 7. List every ASG
curl -s -H "Authorization: Bearer $TOKEN" $API/asgs

# 8. Scale now (launches one t4g.nano). Scale back to 0 afterwards!
curl -s -X PUT $API/asgs/capacity -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"asg":{"accountId":"<account>","region":"ap-south-1","asgName":"cloudops-test-asg"},"capacity":{"min":0,"desired":1,"max":2},"reason":"first test"}'
```

## Clean up

```bash
aws cloudformation delete-stack --stack-name cloudops-test-asg
aws cloudformation delete-stack --stack-name cloudops-access-role
npx cdk destroy
```

## Context flags

| Flag | Default | |
|---|---|---|
| `stage` | `dev` | `prod` keeps data on delete, enables backups, turns off CLI password login |
| `budgetEmail` | none | Turns on the monthly cost alert (50%, 80% and forecast 100%) |
| `monthlyBudgetUsd` | `10` | |
| `allowedOrigins` | `http://localhost:3000` | Comma-separated CORS origins |

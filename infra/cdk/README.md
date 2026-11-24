# infra/cdk

AWS CDK (TypeScript) app for the Cloud-Ops platform. One stack, `CloudOps-<stage>`:

| Piece | Service | Why it's cheap |
|---|---|---|
| Data | DynamoDB, on-demand | Pay per request, $0 when idle. Backups only in prod |
| Auth | Cognito, **Lite** plan | Free tier covers 10,000 monthly users |
| API | API Gateway **HTTP API** + ARM Lambdas | HTTP API is the cheaper flavour; ARM Lambdas; throttled at 20 req/s |
| Logs | CloudWatch Logs | Kept 1 week only |
| Web app | S3 (private) + CloudFront | CloudFront's always-free tier: 1 TB and 10M requests a month |
| Cost alert | AWS Budgets (whole account) | Budgets without actions are free |
| Scheduling | EventBridge Scheduler | 14M invocations a month free; the insights sweep is 120 a month |
| Email (optional) | Amazon SES | $0.10 per 1,000 emails; off unless you set a sender |

There's no VPC, NAT gateway, load balancer or always-on server. Idle cost is about $0. In `dev`, everything is deleted by `cdk destroy`.

## Deploy to your account

Prerequisites: Node 20+, AWS CLI v2 signed in (`aws configure` or `aws sso login`), and a region set (e.g. `ap-south-1`).

Set your budget email once, so a deploy can never drop the cost alert:

```bash
echo 'export CLOUDOPS_BUDGET_EMAIL=you@example.com' >> ~/.zshrc
source ~/.zshrc
```

Then, from the repo root:

```bash
npm install
cd infra/cdk && npx cdk bootstrap && cd ../..
npm run deploy
```

### Custom domain (optional)

Serve the app at your own subdomain, e.g. `app.matheen.in`, instead of the CloudFront URL. Only that subdomain moves to Route 53; the rest of the domain (a website on Vercel, email) stays where it is. Costs $0.50/month for the hosted zone; the certificate is free. The stack must be in **us-east-1**, because CloudFront only uses certificates from there.

1. Create a Route 53 zone for the subdomain. It prints the zone ID and four name servers:

```bash
aws route53 create-hosted-zone --name app.matheen.in --caller-reference cloudops-app-$(date +%s) --query "[HostedZone.Id, DelegationSet.NameServers]" --output text
```

2. Where the parent domain's DNS is managed (GoDaddy → DNS, or Vercel → Domains if it uses Vercel's name servers), add four **NS** records with host/name `app`, one per name server.

3. Check the delegation (it should list the four `awsdns` servers), then deploy:

```bash
dig NS app.matheen.in +short
echo 'export CLOUDOPS_DOMAIN_NAME=app.matheen.in' >> ~/.zshrc
echo 'export CLOUDOPS_HOSTED_ZONE_ID=Z0123456789ABC' >> ~/.zshrc
source ~/.zshrc
npm run deploy
```

The certificate validates by itself through the zone, which takes a few minutes. The CloudFront URL keeps working, and invite links switch to the custom domain.

### Platform operator

You (whoever runs this deployment) can see every workspace and change plans from a **Platform** page in the app, until billing does it automatically. Set your email once, the same way as the budget email:

```bash
echo 'export CLOUDOPS_OPERATOR_EMAILS=you@example.com' >> ~/.zshrc
source ~/.zshrc
npm run deploy
```

Several people: separate the emails with commas. The email must be the one you sign in with, and Cognito must have verified it.

### Email notifications (optional)

Slack and AWS DevOps Agent need nothing on the platform side. Email needs a sender address verified in SES in the platform region:

```bash
aws sesv2 create-email-identity --email-identity alerts@yourdomain.com
echo 'export CLOUDOPS_SENDER_EMAIL=alerts@yourdomain.com' >> ~/.zshrc
source ~/.zshrc
npm run deploy
```

Click the link in the verification email first. While SES is in sandbox mode it only delivers to verified addresses, so verify each recipient too (or request production access).

`npm run deploy` builds the web app and runs `cdk deploy`. The site, its `config.json` and a CloudFront cache refresh all go out together. Open the `WebUrl` output to use the app.

### Local development

```bash
npm run config -w @cloud-ops/web
npm run dev
```

`config` writes `apps/web/public/config.json` from the deployed stack's outputs, so `http://localhost:3000` talks to the same API and Cognito pool.

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

# 5. Optional: a test ASG at 0 instances ($0 until you scale it).
#    Only uses subnets in zones that offer t4g.nano (us-east-1e doesn't).
AZS=$(aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters Name=instance-type,Values=t4g.nano --query 'InstanceTypeOfferings[].Location' --output text | tr '\t' ',')
SUBNETS=$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true Name=availability-zone,Values=$AZS \
  --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')
aws cloudformation deploy --stack-name cloudops-test-asg \
  --template-file ../test-fixtures/test-asg.yaml \
  --parameter-overrides SubnetIds=$SUBNETS

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
| `budgetEmail` | env `CLOUDOPS_BUDGET_EMAIL` | Turns on the monthly cost alert (50%, 80% and forecast 100%) |
| `monthlyBudgetUsd` | `10` | |
| `allowedOrigins` | `http://localhost:3000` | Comma-separated CORS origins |

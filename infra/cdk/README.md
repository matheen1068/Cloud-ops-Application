# infra/cdk

AWS CDK (TypeScript) app for the Cloud-Ops platform, deployed to the platform account. Coming next.

Planned stacks:

- **Auth:** Cognito user pool (tenants, users, roles)
- **Data:** DynamoDB (tenants, accounts, ASG cache, scale events, audit)
- **API:** API Gateway + Lambdas from `services/api`, plus `CloudOpsPlatformRole`, the role that assumes `CloudOpsAccessRole` in customer accounts
- **Scheduler:** EventBridge Scheduler + Step Functions to run scale events and scale back
- **Web:** S3 + CloudFront for `apps/web`

The customer-side role is not defined here. It lives in `onboarding/`.

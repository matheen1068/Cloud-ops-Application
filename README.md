# Cloud-Ops

A SaaS for managing and scaling Auto Scaling groups across many AWS accounts from one place: live events, sales, launches, or day-to-day operations. It's built for solo engineers and startups with a few accounts, and for MSPs managing many customers' accounts.

## Repo layout

```
apps/web/              React UI: Cognito sign-in, live accounts and ASGs, scale now
services/api/          TypeScript Lambda handlers: accounts, ASGs, scale now, readiness, scale events, schedules
packages/shared/       Types shared by web, API and infra
infra/cdk/             AWS CDK app for the platform (serverless, ~$0 idle)
infra/test-fixtures/   A $0 test ASG for trying the API
onboarding/
  cloudformation/      Customer access role: quick-create link or StackSet
  terraform/           Same role as a Terraform module
```

## How customers connect

Every connected account gets one role, `CloudOpsAccessRole`, which trusts only the Cloud-Ops platform role and requires the tenant's external ID. Customers create it one of three ways:

1. **One account:** CloudFormation quick-create link from the app
2. **Whole organization:** the same template as a service-managed StackSet
3. **Terraform users:** the module in `onboarding/terraform`

## Run the web app locally

```bash
npm install
npm run config -w @cloud-ops/web
npm run dev
```

The `config` step pulls the API and Cognito settings from your deployed `CloudOps-dev` stack. The app opens on http://localhost:3000.

Live: sign-in/sign-up, Dashboard, Account Explorer (Scale with readiness check), Scale Events, Schedules and Connect Account. Analytics, Capacity Balancer and the AI advisor are still previews with sample data. The Gemini key (`apps/web/.env.local`) is only used by `npm run dev` and never goes into a production build.

## Deploy the platform

`npm run deploy` builds the web app and deploys everything (API, Cognito, DynamoDB, S3 + CloudFront). See [`infra/cdk/README.md`](infra/cdk/README.md) for first-time setup and a curl walkthrough.

## Checks

```bash
npm run lint                    # type-check every package
npm test -w @cloud-ops/api      # API tests against mocked AWS
```

## Stack

TypeScript end to end: React + Vite, Node.js Lambdas, AWS CDK. Terraform (HCL) is used only for the customer onboarding module.

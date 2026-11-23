# Cloud-Ops

A SaaS for managing and scaling Auto Scaling groups across many AWS accounts from one place: live events, sales, launches, or day-to-day operations. It's built for solo engineers and startups with a few accounts, and for MSPs managing many customers' accounts.

## Repo layout

```
apps/web/              React UI (design prototype from Google AI Studio, simulated data)
services/api/          TypeScript Lambda handlers (/me, /accounts, /asgs, /asgs/capacity)
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

## Run the web app

```bash
npm install
npm run dev        # http://localhost:3000
```

The AI advisor needs `GEMINI_API_KEY` in `apps/web/.env.local`. It is design-only for now and will move behind the API.

## Deploy the platform

See [`infra/cdk/README.md`](infra/cdk/README.md): `npx cdk deploy`, then a step-by-step test with curl.

## Checks

```bash
npm run lint                    # type-check every package
npm test -w @cloud-ops/api      # API tests against mocked AWS
```

## Stack

TypeScript end to end: React + Vite, Node.js Lambdas, AWS CDK. Terraform (HCL) is used only for the customer onboarding module.

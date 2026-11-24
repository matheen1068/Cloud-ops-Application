# Cloud-Ops product repo

Multi-account AWS scaling SaaS: connect AWS accounts with one IAM role each, then see, scale, schedule and plan events for Auto Scaling groups and ECS services from one UI. Every Claude session and agent in this repo reads this file.

**This repo is public.** No pricing, strategy, customer names, legal notes or secrets here; those live in the private HQ repo.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Domain types and small helpers used by both the API and the web app. Start here when adding a field. |
| `services/api/src/handlers` | One file per Lambda. Thin: read the request, `resolveTenant`, `requireRole`, scope check, call a lib function, return `json(...)`. |
| `services/api/src/lib` | The logic: `db.ts` (single DynamoDB table), `tenant.ts`, `scope.ts` (client scoping), `approvals.ts`, `capacity.ts` (ASG and ECS read/write), `events.ts`, `schedules.ts`, `readiness.ts`, `ecs*.ts`, `notify.ts`, `team.ts`, `org.ts`, `plans.ts`. |
| `services/api/test` | `node:test` + `tsx` + `aws-sdk-client-mock`, with an in-memory DynamoDB. One file per feature area. |
| `apps/web` | React + Vite + Tailwind. API client in `lib/api.ts`, adapters in `lib/adapters.ts`, pages in `components/`. |
| `infra/cdk` | One CDK stack `CloudOps-<stage>`. Routes are the `routes` array in `lib/api.ts`. |
| `onboarding/` | The customer's IAM role, as CloudFormation and as Terraform. |
| `infra/test-fixtures` | A zero-cost ASG and Fargate service for testing. |

## Commands

```bash
npm install
npm test -w @cloud-ops/api
npm run lint
npm run build -w @cloud-ops/web
cd infra/cdk && npx cdk synth -q -c budgetEmail=test@example.com
cfn-lint infra/cdk/cdk.out/CloudOps-dev.template.json -i W3005 W2001
cfn-lint onboarding/cloudformation/cloudops-access-role.yaml
checkov -d onboarding --framework cloudformation terraform --compact
```

## Rules that keep customers safe

- **Tenant isolation.** The tenant always comes from `resolveTenant(getCaller(event))`, never from the request body or path. Every DynamoDB key starts with `TENANT#<tenantId>`.
- **Client scoping.** Any handler that reads or changes accounts, ASGs, services, events, schedules, approvals, insights or audit entries filters with `lib/scope.ts`. Hidden accounts answer 404.
- **Roles.** `requireRole` with `ADMIN_ROLES` or `OPERATOR_ROLES` before any change.
- **Approvals.** Changes on accounts with `requireApproval` go through `approvalGate`; never add a path that skips it.
- **Customer accounts.** Only through `assumeAccessRole(roleArn, tenant.externalId, tenantId)`. A ref is an ASG, or an ECS service with `kind: 'ecs'` and `cluster`; use `ClientPool.read/write`.
- **Onboarding templates.** CloudFormation and Terraform grant exactly the same actions, scoped to resources wherever IAM allows, and checkov stays clean.
- **Notifications** are best-effort and never fail the scaling work.

## Rules that keep costs near zero

Serverless and pay-per-use only: ARM Lambdas, DynamoDB on-demand, HTTP API, EventBridge Scheduler. No VPC, NAT, load balancer or always-on server. API Lambdas finish in under 29 seconds (API Gateway's limit); longer work goes to the runner. After `cdk synth`, check for dependency cycles.

## How we work

- Branch per change (`feat/...`), small PRs, tests in the same PR. Never push to `main`.
- Never deploy (`npm run deploy`, `cdk deploy`) and never run AWS CLI commands that change anything. Matheen deploys from his Mac.
- Never commit secrets, `.env` files or AWS account data.
- Matheen uses zsh, which breaks on pasted `#` comments. Give him shell commands without comments.
- In cloud sessions, `gh pr create` is blocked; open PRs with `gh api repos/matheen1068/Cloud-ops-Application/pulls`.

## The build crew

| Agent | Colour | Call it with | Does |
|---|---|---|---|
| developer | blue | `@agent-developer` | Builds features and fixes, with tests |
| qa-security | orange | `@agent-qa-security` | Reviews changes for bugs, isolation, IAM and cost; never edits |

Flow: developer opens a PR, qa-security reviews it, Matheen merges and deploys.

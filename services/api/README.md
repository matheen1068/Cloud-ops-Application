# services/api

TypeScript Lambda handlers for the Cloud-Ops API. CDK bundles them with esbuild, so there's no separate build step. All routes need a Cognito ID token (`Authorization: Bearer <token>`).

| Route | Handler | What it does |
|---|---|---|
| `GET /me` | `me.ts` | Your user, workspace and plan. Creates a free workspace on first sign-in. Owners and admins also get the onboarding values (platform account, platform role, external ID) |
| `GET /accounts` | `accounts.ts` | Connected AWS accounts |
| `POST /accounts` | `accounts.ts` | Connect an account: assumes `CloudOpsAccessRole` with the workspace's external ID and checks the account ID |
| `GET /asgs` | `asgs.ts` | Every ASG across connected accounts and regions, with Spot/On-Demand split. Failures per account/region are returned in `errors` |
| `PUT /asgs/capacity` | `capacity.ts` | Scale now: min/desired/max on one ASG, with before/after written to the audit log |

```
src/
  handlers/   one file per Lambda
  lib/        http helpers, DynamoDB access, tenant/role checks, STS
test/         handler tests against mocked AWS (no account needed)
```

```bash
npm test -w @cloud-ops/api   # run the tests
npm run lint -w @cloud-ops/api
```

Request and response types come from `@cloud-ops/shared`.

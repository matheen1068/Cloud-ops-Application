# services/api

TypeScript Lambda handlers for the Cloud-Ops API. CDK bundles them with esbuild, so there's no separate build step. All routes need a Cognito ID token (`Authorization: Bearer <token>`).

| Route | Handler | What it does |
|---|---|---|
| `GET /me` | `me.ts` | Your user, workspace and plan. Creates a free workspace on first sign-in. Owners and admins also get the onboarding values (platform account, platform role, external ID) |
| `POST /me/workspace` | `me.ts` | Switch the active workspace (people can belong to several) |
| `GET /members` | `members.ts` | Team and pending invites |
| `POST /members/invites` | `members.ts` | Invite by email with a role. Counts against the plan's user limit. Emails the link when SES is set up, otherwise returns it to copy |
| `DELETE /members/invites/{id}` | `members.ts` | Revoke an invite |
| `PUT/DELETE /members/{userId}` | `members.ts` | Change a role, remove someone, or leave. Only owners touch owners; a workspace always keeps one owner |
| `POST /invites/{id}/accept\|decline` | `members.ts` | Answer an invite. The Cognito email must be verified and match |
| `GET /approvals` | `approvals.ts` | Approval requests, newest first |
| `POST /approvals/{id}/approve\|reject\|cancel` | `approvals.ts` | Another owner/admin approves and the change runs as the requester. Owners can approve their own with `breakGlassReason` (emergency, audited) |
| `GET /accounts` | `accounts.ts` | Connected AWS accounts |
| `PUT /accounts/{accountId}` | `accounts.ts` | Rename, change regions, or set `requireApproval` (admins) |
| `POST /accounts` | `accounts.ts` | Connect an account: assumes `CloudOpsAccessRole` with the workspace's external ID and checks the account ID |
| `GET /asgs` | `asgs.ts` | Every ASG across connected accounts and regions, with Spot/On-Demand split. Failures per account/region are returned in `errors` |
| `PUT /asgs/capacity` | `capacity.ts` | Scale now: min/desired/max on one ASG, with before/after written to the audit log |
| `POST /asgs/readiness` | `readiness.ts` | Pre-flight checks for planned capacity: vCPU quota headroom, instance type offered in every ASG zone, instance diversity, single AZ, suspended processes, failed launches in the last 24h, large jumps |
| `GET/POST /scale-events` | `events.ts` | List / create events: pre-scale before `startsAt`, hold, scale back at `endsAt` to the capacity captured at scale-up. Overlapping events on one ASG are rejected |
| `POST /scale-events/{id}/cancel` | `events.ts` | Cancel a scheduled event, or end an active one now |
| `GET/POST /schedules` | `schedules.ts` | List / create recurring off-hours schedules (days, on/off time, timezone) |
| `DELETE /schedules/{id}` | `schedules.ts` | Delete a schedule (ASGs that are off are switched back on first) |
| `POST /scale-events/{id}/investigate` | `events.ts` | Send an event's problems to the workspace's AWS DevOps Agent as a new investigation |
| `GET/PUT /settings` | `settings.ts` | Notification channels (Slack webhook, email recipients, DevOps Agent webhook) and what to notify about. Secrets are stored but only returned masked. Changing settings needs owner or admin |
| `POST /settings/test` | `settings.ts` | Send a test message to every connected channel and report the result per channel |
| `GET /insights`, `POST /insights/run` | `insights.ts` | Last insights report, or run one now: manual scale-ups still in place after N hours, and ASGs averaging under 5% CPU for 24h |
| `GET /audit?limit&cursor` | `audit.ts` | Activity log, newest first, paged |
| (EventBridge Scheduler) | `runner.ts` | Runs event start/end and schedule off/on, plus the 6-hourly insights sweep across workspaces. Idempotent, so scheduler retries are safe |

**Approvals.** On accounts with `requireApproval`, Scale Now, new scale events and new schedules return **202** with `{ approval }` instead of applying. Requests expire after 24 hours, or when an event's pre-scale would start. Approving is a conditional write, so two admins can't apply the same request twice.

**Invites.** A brand-new user whose verified email has a pending invite joins that workspace instead of getting their own. Existing users see the invite in `GET /me` and accept it.

Notifications are best-effort: a failed Slack, email or DevOps Agent call never fails the scaling work. DevOps Agent calls are signed the way its generic webhook expects (HMAC-SHA256 over `<timestamp>:<body>`, Base64, in `x-amzn-event-signature`), or sent with a Bearer API key.

```
src/
  handlers/   one file per Lambda
  lib/        http helpers, DynamoDB access, tenant/role checks, STS
test/         handler tests against mocked AWS (no account needed): handlers.test.ts, phase1.test.ts, phase2.test.ts, phase3-teams.test.ts
```

```bash
npm test -w @cloud-ops/api   # run the tests
npm run lint -w @cloud-ops/api
```

Request and response types come from `@cloud-ops/shared`.

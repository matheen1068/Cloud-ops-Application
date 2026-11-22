# services/api

TypeScript Lambda handlers for the Cloud-Ops API. Coming next.

Planned v1 endpoints:

- `POST /accounts`: connect an account (validates the role with `sts:AssumeRole`)
- `GET /accounts`: list connected accounts and their status
- `GET /asgs`: inventory of ASGs across all connected accounts and regions
- `POST /asgs/capacity`: scale now (min / desired / max)
- `POST /scale-events`: create a scheduled scale event with automatic scale-back
- `GET /audit`: change history

Types come from `@cloud-ops/shared`.

# Cloud-Ops access role: Terraform module

Creates `CloudOpsAccessRole` in an AWS account so the Cloud-Ops platform can discover and scale its Auto Scaling groups. It's the same role, with the same permissions, as [`../cloudformation/cloudops-access-role.yaml`](../cloudformation/cloudops-access-role.yaml). Customers choose whichever tool they already use.

## Usage

```hcl
module "cloudops_access" {
  source = "github.com/matheen1068/Cloud-ops-Application//onboarding/terraform"

  platform_account_id = "111122223333"     # Cloud-Ops platform account
  external_id         = var.cloudops_external_id # shown in the Cloud-Ops app
  access_level        = "Operate"            # or "ReadOnly"
}

output "cloudops_role_arn" {
  value = module.cloudops_access.role_arn    # paste into the Cloud-Ops app
}
```

### Several accounts

Call the module once per account, with a provider alias for each:

```hcl
provider "aws" {
  alias = "prod"
  assume_role { role_arn = "arn:aws:iam::222233334444:role/OrganizationAccountAccessRole" }
}

module "cloudops_prod" {
  source    = "github.com/matheen1068/Cloud-ops-Application//onboarding/terraform"
  providers = { aws = aws.prod }

  platform_account_id = "111122223333"
  external_id         = var.cloudops_external_id
}
```

### Whole organization

See [`examples/organization`](examples/organization). A service-managed StackSet covers every account in the chosen OUs, including new ones, and the module covers the management account.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `platform_account_id` | string | required | Account where Cloud-Ops runs |
| `external_id` | string (sensitive) | required | Per-tenant secret from the app, 16–128 chars |
| `platform_role_name` | string | `CloudOpsPlatformRole` | Role in the platform account allowed to assume this role |
| `role_name` | string | `CloudOpsAccessRole` | Keep the same in every account |
| `access_level` | string | `Operate` | `ReadOnly` or `Operate` |
| `restrict_to_tagged_asgs` | bool | `false` | Only scale ASGs and ECS services tagged `CloudOpsManaged=true`. For an ECS service with auto scaling, tag its scalable target too |
| `is_org_management_account` | bool | `false` | Allow listing child accounts (management account only) |
| `tags` | map(string) | `{}` | Extra tags for the role |

## Outputs

| Name | Description |
|---|---|
| `role_arn` | Paste into the Cloud-Ops app |
| `role_name` | Created role name |
| `access_level` | Access level granted |

## What the role can do

- **Always:** read ASGs, instances, instance types, Spot prices, load balancer health, CloudWatch metrics and service quotas.
- **Operate:** change min/desired/max, manage scheduled actions, suspend/resume scaling processes. Nothing else: no deletes, and no instance or launch template changes.
- **Trust:** only `CloudOpsPlatformRole` in the platform account, and only with your external ID.

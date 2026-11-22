# Connect a whole AWS Organization to Cloud-Ops from Terraform.
# Run this with credentials for the Organization management account.
#
# 1. A service-managed StackSet pushes the CloudFormation version of the role
#    to every account in the chosen OUs, including accounts added later.
# 2. The module creates the same role in the management account itself
#    (StackSets skip it), with org discovery turned on.

provider "aws" {
  region = "us-east-1"
}

variable "platform_account_id" {
  type = string
}

variable "external_id" {
  type      = string
  sensitive = true
}

variable "organizational_unit_ids" {
  description = "OUs to onboard, e.g. [\"r-ab12\"] for the whole organization or [\"ou-ab12-xyz\"]."
  type        = list(string)
}

resource "aws_cloudformation_stack_set" "cloudops_access" {
  name             = "cloudops-access-role"
  permission_model = "SERVICE_MANAGED"
  capabilities     = ["CAPABILITY_NAMED_IAM"]
  template_body    = file("${path.module}/../../../cloudformation/cloudops-access-role.yaml")
  # Use call_as = "DELEGATED_ADMIN" if you run this from a delegated admin account.

  parameters = {
    PlatformAccountId = var.platform_account_id
    ExternalId        = var.external_id
    AccessLevel       = "Operate"
  }

  auto_deployment {
    enabled                          = true
    retain_stacks_on_account_removal = false
  }

  lifecycle {
    ignore_changes = [administration_role_arn]
  }
}

# IAM is global, so one region is enough. This deploys in the provider's region.
resource "aws_cloudformation_stack_set_instance" "cloudops_access" {
  stack_set_name = aws_cloudformation_stack_set.cloudops_access.name

  deployment_targets {
    organizational_unit_ids = var.organizational_unit_ids
  }
}

module "management_account" {
  source = "../.."

  platform_account_id       = var.platform_account_id
  external_id               = var.external_id
  is_org_management_account = true
}

output "management_role_arn" {
  value = module.management_account.role_arn
}

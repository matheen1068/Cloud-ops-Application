# Connect one AWS account to Cloud-Ops.
#   terraform init
#   terraform apply -var platform_account_id=111122223333 -var external_id=<from the app>

provider "aws" {
  region = "us-east-1" # IAM is global; any region works
}

variable "platform_account_id" {
  type = string
}

variable "external_id" {
  type      = string
  sensitive = true
}

module "cloudops_access" {
  source = "../.."

  platform_account_id = var.platform_account_id
  external_id         = var.external_id
  access_level        = "Operate" # or "ReadOnly" to try it safely first
}

output "role_arn" {
  value = module.cloudops_access.role_arn
}

variable "platform_account_id" {
  description = "AWS account ID where the Cloud-Ops platform runs."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.platform_account_id))
    error_message = "platform_account_id must be a 12-digit AWS account ID."
  }
}

variable "platform_role_name" {
  description = "Role in the platform account that is allowed to assume this role."
  type        = string
  default     = "CloudOpsPlatformRole"
}

variable "external_id" {
  description = "Unique per tenant, shown in the Cloud-Ops app. Prevents confused-deputy access."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.external_id) >= 16 && length(var.external_id) <= 128
    error_message = "external_id must be 16 to 128 characters."
  }
}

variable "role_name" {
  description = "Name of the role created in this account. Keep it the same in every account."
  type        = string
  default     = "CloudOpsAccessRole"
}

variable "access_level" {
  description = "ReadOnly = inventory and metrics only. Operate = can also change capacity and schedules."
  type        = string
  default     = "Operate"

  validation {
    condition     = contains(["ReadOnly", "Operate"], var.access_level)
    error_message = "access_level must be ReadOnly or Operate."
  }
}

variable "restrict_to_tagged_asgs" {
  description = "If true, scaling is allowed only on ASGs tagged CloudOpsManaged=true."
  type        = bool
  default     = false
}

variable "is_org_management_account" {
  description = "Set true only in the Organization management account, to allow listing child accounts."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags for the IAM role."
  type        = map(string)
  default     = {}
}

# Cloud-Ops access role, the Terraform version of
# onboarding/cloudformation/cloudops-access-role.yaml. Both create the same role
# with the same permissions, so the platform treats them identically.

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  partition     = data.aws_partition.current.partition
  account_id    = data.aws_caller_identity.current.account_id
  can_operate   = var.access_level == "Operate"
  platform_role = "arn:${local.partition}:iam::${var.platform_account_id}:role/${var.platform_role_name}"
  asg_arns      = "arn:${local.partition}:autoscaling:*:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/*"

  scale_actions = [
    "autoscaling:UpdateAutoScalingGroup",
    "autoscaling:SetDesiredCapacity",
    "autoscaling:PutScheduledUpdateGroupAction",
    "autoscaling:BatchPutScheduledUpdateGroupAction",
    "autoscaling:DeleteScheduledAction",
    "autoscaling:BatchDeleteScheduledAction",
    "autoscaling:SuspendProcesses",
    "autoscaling:ResumeProcesses",
  ]
}

# Trust: only the platform role, and only with this tenant's external ID.
data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "AllowCloudOpsPlatform"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${var.platform_account_id}:root"]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.platform_role]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.role_name
  description          = "Assumed by the Cloud-Ops platform to discover and scale Auto Scaling groups."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = merge({ ManagedBy = "Cloud-Ops" }, var.tags)
}

# Always granted: inventory and metrics.
data "aws_iam_policy_document" "read" {
  statement {
    sid    = "InventoryAndMetrics"
    effect = "Allow"
    actions = [
      "autoscaling:Describe*",
      "ec2:DescribeRegions",
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeInstanceTypeOfferings",
      "ec2:DescribeLaunchTemplates",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:DescribeSpotPriceHistory",
      "ec2:GetInstanceTypesFromInstanceRequirements",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
      "servicequotas:ListServiceQuotas",
      "ecs:ListClusters",
      "ecs:ListServices",
      "ecs:DescribeTaskDefinition",
      "application-autoscaling:DescribeScalableTargets",
      "application-autoscaling:DescribeScalingActivities",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "ReadEcsServices"
    effect  = "Allow"
    actions = ["ecs:DescribeClusters", "ecs:DescribeServices"]
    resources = [
      "arn:${local.partition}:ecs:*:${local.account_id}:cluster/*",
      "arn:${local.partition}:ecs:*:${local.account_id}:service/*",
    ]
  }

  statement {
    sid       = "ReadAlarms"
    effect    = "Allow"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["arn:${local.partition}:cloudwatch:*:${local.account_id}:alarm:*"]
  }

  # EC2 and Fargate vCPU quotas, checked before a big scale-up.
  statement {
    sid       = "ReadComputeQuotas"
    effect    = "Allow"
    actions   = ["servicequotas:GetServiceQuota"]
    resources = [
      "arn:${local.partition}:servicequotas:*:${local.account_id}:ec2/*",
      "arn:${local.partition}:servicequotas:*:${local.account_id}:fargate/*",
    ]
  }
}

resource "aws_iam_role_policy" "read" {
  name   = "CloudOpsRead"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.read.json
}

# Operate only: capacity and schedule changes. Changing launch templates or
# mixed instances settings later will also need ec2:RunInstances / iam:PassRole.
data "aws_iam_policy_document" "scale" {
  statement {
    sid       = "ScaleAutoScalingGroups"
    effect    = "Allow"
    actions   = local.scale_actions
    resources = [local.asg_arns]

    dynamic "condition" {
      for_each = var.restrict_to_tagged_asgs ? [1] : []
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/CloudOpsManaged"
        values   = ["true"]
      }
    }
  }

  statement {
    sid       = "ScaleEcsServices"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = ["arn:${local.partition}:ecs:*:${local.account_id}:service/*"]

    dynamic "condition" {
      for_each = var.restrict_to_tagged_asgs ? [1] : []
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/CloudOpsManaged"
        values   = ["true"]
      }
    }
  }

  # Only ECS desired-count targets, never other scalable targets (DynamoDB, Lambda...).
  statement {
    sid       = "ScaleEcsAutoScalingTargets"
    effect    = "Allow"
    actions   = ["application-autoscaling:RegisterScalableTarget"]
    resources = ["arn:${local.partition}:application-autoscaling:*:${local.account_id}:scalable-target/*"]

    condition {
      test     = "StringEquals"
      variable = "application-autoscaling:service-namespace"
      values   = ["ecs"]
    }
    condition {
      test     = "StringEquals"
      variable = "application-autoscaling:scalable-dimension"
      values   = ["ecs:service:DesiredCount"]
    }

    dynamic "condition" {
      for_each = var.restrict_to_tagged_asgs ? [1] : []
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/CloudOpsManaged"
        values   = ["true"]
      }
    }
  }
}

resource "aws_iam_role_policy" "scale" {
  count  = local.can_operate ? 1 : 0
  name   = var.restrict_to_tagged_asgs ? "CloudOpsScaleTagged" : "CloudOpsScale"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.scale.json
}

# Management account only: lets the platform discover child accounts.
data "aws_iam_policy_document" "org" {
  statement {
    sid    = "DescribeOrganization"
    effect = "Allow"
    actions = [
      "organizations:DescribeOrganization",
      "organizations:ListAccounts",
      "organizations:ListRoots",
    ]
    resources = ["*"]
  }

  # Walking the OU tree: scoped to this organization's root and OUs.
  statement {
    sid    = "WalkOrganizationTree"
    effect = "Allow"
    actions = [
      "organizations:ListOrganizationalUnitsForParent",
      "organizations:ListAccountsForParent",
    ]
    resources = [
      "arn:${local.partition}:organizations::${local.account_id}:root/o-*/r-*",
      "arn:${local.partition}:organizations::${local.account_id}:ou/o-*/ou-*",
    ]
  }
}

resource "aws_iam_role_policy" "org" {
  count  = var.is_org_management_account ? 1 : 0
  name   = "CloudOpsOrgDiscovery"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.org.json
}

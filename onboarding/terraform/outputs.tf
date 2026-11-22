output "role_arn" {
  description = "Paste this into the Cloud-Ops app to finish connecting the account."
  value       = aws_iam_role.this.arn
}

output "role_name" {
  value = aws_iam_role.this.name
}

output "access_level" {
  value = var.access_level
}

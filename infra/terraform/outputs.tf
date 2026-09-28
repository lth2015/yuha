/**
 * Outputs feed the Helm values and the CI deploy step.
 * No secret value is output — the database URL lives in Secrets Manager and is
 * referenced by ARN only (SEC-06).
 */

output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "api_role_arn" {
  description = "Annotate the yuha-api service account with this (namespace yuha)."
  value       = module.api_irsa.iam_role_arn
}

output "worker_role_arn" {
  description = "Annotate the yuha-worker service account with this (namespace yuha)."
  value       = module.worker_irsa.iam_role_arn
}

output "database_secret_arn" {
  description = "Secrets Manager ARN holding the connection URL. The value itself is never output."
  value       = aws_secretsmanager_secret.db.arn
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "quarantine_bucket" {
  value = aws_s3_bucket.quarantine.id
}

output "delivery_bucket" {
  value = aws_s3_bucket.delivery.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.id
}

output "sqs_queue_url" {
  value = aws_sqs_queue.generation.url
}

output "sqs_dlq_url" {
  value = aws_sqs_queue.generation_dlq.url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_app_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "ecr_api_repository" {
  value = aws_ecr_repository.api.repository_url
}

output "ecr_worker_repository" {
  value = aws_ecr_repository.worker.repository_url
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "kms_media_key_arn" {
  value = aws_kms_key.media.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

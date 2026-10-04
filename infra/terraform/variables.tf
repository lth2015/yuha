variable "region" {
  description = "AWS region. Tokyo is the primary region (§4.2)."
  type        = string
  default     = "ap-northeast-1"
}

variable "environment" {
  description = "Deployment environment. Only \"production\" enables Multi-AZ, deletion protection and a private EKS endpoint; dev, qa and staging are identical in shape and differ only by name."
  type        = string

  validation {
    condition     = contains(["dev", "qa", "staging", "production"], var.environment)
    error_message = "environment must be dev, qa, staging or production."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "eks_version" {
  type    = string
  default = "1.31"
}

variable "node_instance_types" {
  description = "Worker nodes run ffmpeg, so the instance type must have real CPU headroom."
  type        = list(string)
  default     = ["t3.large"]
}

variable "worker_max_nodes" {
  description = "Upper bound on worker nodes. §12.3: scaling must not be used to paper over a persistent upstream fault, and the real ceiling is the provider's concurrency quota."
  type        = number
  default     = 4
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "web_callback_urls" {
  description = "Allowed Cognito callback URLs for the web client."
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "ses_source_arn" {
  description = "SES identity ARN for Cognito email. Required for production volume; the Cognito default sender is rate-limited."
  type        = string
  default     = ""
}

variable "ses_from_address" {
  type    = string
  default = ""
}

variable "alert_email" {
  description = "Where CloudWatch alarms are delivered. Leave empty to skip the subscription."
  type        = string
  default     = ""
}

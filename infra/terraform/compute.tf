/**
 * EKS, workload identity and the static web delivery path.
 */

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = local.name
  cluster_version = var.eks_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # The API endpoint stays private in production; CI reaches it through a
  # bastion or a VPN, never over the open internet.
  cluster_endpoint_public_access  = var.environment != "production"
  cluster_endpoint_private_access = true

  enable_irsa = true

  cluster_enabled_log_types = ["api", "audit", "authenticator"]

  eks_managed_node_group_defaults = {
    ami_type       = "AL2023_x86_64_STANDARD"
    instance_types = var.node_instance_types
  }

  eks_managed_node_groups = {
    # The worker runs ffmpeg, which is CPU-bound; keeping it in its own group
    # stops audio processing from starving API latency.
    api = {
      min_size     = var.environment == "production" ? 2 : 1
      max_size     = 6
      desired_size = var.environment == "production" ? 2 : 1
      labels       = { workload = "api" }
    }
    worker = {
      min_size     = 1
      max_size     = var.worker_max_nodes
      desired_size = 1
      labels       = { workload = "worker" }
      taints = [{
        key    = "workload"
        value  = "worker"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  tags = local.tags
}

# ------------------------------------------------- workload identity (IRSA)

/**
 * Least-privilege roles per workload (SEC-06). The API can read delivery
 * objects and enqueue; the worker can additionally write both zones. Neither
 * holds a long-lived access key — credentials come from the pod's identity.
 */
data "aws_iam_policy_document" "api" {
  statement {
    sid       = "DeliveryObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.delivery.arn}/*"]
  }

  statement {
    sid       = "EnqueueGeneration"
    effect    = "Allow"
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    resources = [aws_sqs_queue.generation.arn]
  }

  statement {
    sid       = "ReadRuntimeSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn, aws_secretsmanager_secret.app.arn]
  }

  statement {
    sid       = "UseMediaKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.media.arn]
  }
}

data "aws_iam_policy_document" "worker" {
  source_policy_documents = [data.aws_iam_policy_document.api.json]

  statement {
    sid       = "QuarantineObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.quarantine.arn}/*"]
  }

  statement {
    sid    = "ConsumeGeneration"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.generation.arn]
  }
}

resource "aws_iam_policy" "api" {
  name   = "${local.name}-api"
  policy = data.aws_iam_policy_document.api.json
  tags   = local.tags
}

resource "aws_iam_policy" "worker" {
  name   = "${local.name}-worker"
  policy = data.aws_iam_policy_document.worker.json
  tags   = local.tags
}

module "api_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name        = "${local.name}-api"
  role_policy_arns = { policy = aws_iam_policy.api.arn }

  oidc_providers = {
    main = {
      provider_arn = module.eks.oidc_provider_arn
      # Must equal the ServiceAccount the chart creates, in the namespace the
      # release is installed into. AWS resources stay `loopscene-*`; everything
      # inside the cluster is `yuha` (see infra/helm/loopscene/values.yaml).
      # `yuha-external-secrets` is the ServiceAccount the SecretStore in
      # deploy/cluster/external-secrets.yaml authenticates as; it reads the same
      # two secrets this role already allows.
      namespace_service_accounts = ["yuha:yuha-api", "yuha:yuha-external-secrets"]
    }
  }
  tags = local.tags
}

module "worker_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name        = "${local.name}-worker"
  role_policy_arns = { policy = aws_iam_policy.worker.arn }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["yuha:yuha-worker"]
    }
  }
  tags = local.tags
}

# ---------------------------------------------------------- runtime secrets

/**
 * Application secrets. Terraform creates the container with placeholders; the
 * real values are written out of band (§3.2 — no real key belongs in the repo
 * or in Terraform state).
 */
resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  recovery_window_in_days = var.environment == "production" ? 30 : 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "app_placeholder" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    STRIPE_SECRET_KEY     = "REPLACE_OUT_OF_BAND"
    STRIPE_WEBHOOK_SECRET = "REPLACE_OUT_OF_BAND"
    TOKENSTARS_API_KEY    = "REPLACE_OUT_OF_BAND"
    MUSIC_API_KEY         = "REPLACE_OUT_OF_BAND"
  })

  lifecycle {
    # Never overwrite real values with placeholders on a later apply.
    ignore_changes = [secret_string]
  }
}

# ------------------------------------------------------------- ECR + web CDN

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
  }
  tags = local.tags
}

resource "aws_ecr_repository" "worker" {
  name                 = "${local.name}-worker"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

# The built SPA is static; CloudFront serves it from a private bucket via OAC.
resource "aws_s3_bucket" "web" {
  bucket = "${local.name}-web"
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  comment             = "${local.name} web"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # CachingOptimized
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # The SPA owns its routes, so a deep link must return index.html rather than
  # a 404 page.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.tags
}

resource "aws_s3_bucket_policy" "web_oac" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn }
      }
    }]
  })
}

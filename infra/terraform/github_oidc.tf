/**
 * GitHub Actions → AWS, without a static access key.
 *
 * The deploy workflow assumes this role through GitHub's OIDC provider, so
 * nothing long-lived is stored in repository secrets. The trust policy is
 * restricted to this repository *and* to the refs that are allowed to deploy;
 * a wildcard `repo:owner/name:*` would let any branch in any fork-triggered
 * workflow assume it.
 *
 * Kept in this stack rather than in `deploy/` deliberately: it is an AWS
 * resource, and splitting Terraform across two states to mirror a folder
 * layout buys nothing and costs a second `apply` to keep in step.
 */

variable "github_repository" {
  description = "owner/name of the repository allowed to assume the deploy role."
  type        = string
  default     = "lth2015/music"
}

variable "github_deploy_refs" {
  description = <<-EOT
    Git refs permitted to deploy, as OIDC `sub` suffixes. Defaults to the
    default branch and tags. Add `environment:production` here instead of a
    branch if you gate production behind a GitHub Environment.
  EOT
  type        = list(string)
  default     = ["ref:refs/heads/master", "ref:refs/tags/v*"]
}

variable "github_oidc_provider_arn" {
  description = <<-EOT
    ARN of an existing GitHub OIDC provider in this account. Leave empty to
    create one. An account may only have a single provider for a given URL, so
    if another stack already created it, pass the ARN instead.
  EOT
  type        = string
  default     = ""
}

locals {
  create_github_oidc = var.github_oidc_provider_arn == ""
  github_oidc_arn    = local.create_github_oidc ? aws_iam_openid_connect_provider.github[0].arn : var.github_oidc_provider_arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.create_github_oidc ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS verifies GitHub's certificate chain itself for this provider; the
  # thumbprint is still required by the API and this is GitHub's published one.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.tags
}

data "aws_iam_policy_document" "github_deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Narrow to this repository and to the refs allowed to deploy.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for r in var.github_deploy_refs : "repo:${var.github_repository}:${r}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  description        = "Assumed by GitHub Actions to push images and run helm upgrade."
  assume_role_policy = data.aws_iam_policy_document.github_deploy_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "github_deploy" {
  # Push images to this environment's two repositories, and nothing else.
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [
      aws_ecr_repository.api.arn,
      aws_ecr_repository.worker.arn,
    ]
  }

  # Enough to run `aws eks update-kubeconfig`. Authorisation inside the cluster
  # comes from the access entry below, not from IAM.
  statement {
    sid       = "EksDescribe"
    effect    = "Allow"
    actions   = ["eks:DescribeCluster"]
    resources = [module.eks.cluster_arn]
  }
}

resource "aws_iam_policy" "github_deploy" {
  name   = "${local.name}-github-deploy"
  policy = data.aws_iam_policy_document.github_deploy.json
  tags   = local.tags
}

resource "aws_iam_role_policy_attachment" "github_deploy" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.github_deploy.arn
}

/**
 * Cluster authorisation.
 *
 * The role is given a namespace-scoped admin binding rather than
 * cluster-admin: the workflow's job is to upgrade one release in one
 * namespace, and the migration hook it runs is the most destructive thing it
 * needs to be able to do.
 */
resource "aws_eks_access_entry" "github_deploy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.github_deploy.arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "github_deploy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.github_deploy.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"

  access_scope {
    type       = "namespace"
    namespaces = [var.k8s_namespace]
  }

  depends_on = [aws_eks_access_entry.github_deploy]
}

variable "k8s_namespace" {
  description = "Namespace the application release is deployed into."
  type        = string
  default     = "yuha"
}

output "github_deploy_role_arn" {
  description = "Set as AWS_DEPLOY_ROLE_ARN in the repository's Actions variables."
  value       = aws_iam_role.github_deploy.arn
}

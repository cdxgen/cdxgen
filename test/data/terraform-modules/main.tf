# module "c1" {
#   source = "commented/only/c1"
# }

/* module "c2" { source = "x/y/z" } */

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.1"
  tags = {
    note = "}{"
  }
}

module "label_git" {
  source = "git::https://github.com/cloudposse/terraform-null-label.git?ref=0.25.0"
}

module "network" {
  source = "./modules/network"
}

locals {
  doc = <<-EOT
    module "heredoc" {
      source = "a/b/c"
    }
  EOT
}

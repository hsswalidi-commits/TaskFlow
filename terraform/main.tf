terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.2.0"
    }
  }

  # The hosted runner's local state is saved/restored as a GitHub Actions artifact.
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  description = "Google Cloud project that owns TaskFlow."
  type        = string
  default     = "leap-coop"
}

variable "region" {
  description = "Region for Artifact Registry and Cloud Run."
  type        = string
  default     = "me-central1"
}

variable "service_name" {
  description = "Unique Cloud Run service name for this TaskFlow instance."
  type        = string
  default     = "taskflow-hussam"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,47}[a-z0-9])?$", var.service_name))
    error_message = "service_name must be a valid lowercase Cloud Run service name of 1-49 characters."
  }
}

variable "image" {
  description = "Immutable Artifact Registry image reference pinned by sha256 digest."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be an Artifact Registry image reference pinned with @sha256:<64 lowercase hex characters>."
  }
}

variable "runtime_service_account_email" {
  description = "Existing service account email used by the Cloud Run runtime."
  type        = string
}

variable "runtime_secret_versions" {
  description = "Pinned Secret Manager versions injected into the Cloud Run revision."
  type        = map(string)
  sensitive   = true
  default = {
    openrouter = "1"
  }

  validation {
    condition     = contains(keys(var.runtime_secret_versions), "openrouter") && can(regex("^[1-9][0-9]*$", var.runtime_secret_versions["openrouter"]))
    error_message = "runtime_secret_versions must include a positive numeric openrouter version; use a pinned version instead of latest."
  }
}

variable "max_instances" {
  description = "Upper bound on concurrent Cloud Run instances to limit scaling and cost."
  type        = number
  default     = 3

  validation {
    condition     = var.max_instances >= 1 && floor(var.max_instances) == var.max_instances
    error_message = "max_instances must be an integer greater than or equal to 1."
  }
}

variable "deletion_protection" {
  description = "Protect the Cloud Run service from accidental Terraform deletion. Disable only for an explicitly confirmed teardown."
  type        = bool
  default     = true
}

variable "openrouter_model" {
  description = "OpenRouter model used by the Flask Copilot."
  type        = string
  default     = "openai/gpt-4o-mini"
}

variable "monitoring_notification_channels" {
  description = "Optional Cloud Monitoring notification channel resource names."
  type        = list(string)
  default     = []
}

locals {
  service_name = var.service_name
}

resource "google_artifact_registry_repository" "taskflow" {
  project       = var.project_id
  location      = var.region
  repository_id = "taskflowhassan"
  description   = "TaskFlow application container images"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true
  }
}

resource "google_secret_manager_secret" "openrouter_api_key" {
  project   = var.project_id
  secret_id = "taskflow-openrouter-api-key"

  replication {
    auto {}
  }
}

resource "google_cloud_run_v2_service" "taskflow" {
  project             = var.project_id
  name                = local.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account                  = var.runtime_service_account_email
    max_instance_request_concurrency = 4
    timeout                          = "120s"

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "PORT"
        value = "8080"
      }

      env {
        name  = "PYTHONUNBUFFERED"
        value = "1"
      }

      env {
        name  = "FLASK_ENV"
        value = "production"
      }

      env {
        name  = "OPENROUTER_MODEL"
        value = var.openrouter_model
      }

      env {
        name = "OPENROUTER_API_KEY"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.openrouter_api_key.secret_id
            version = var.runtime_secret_versions["openrouter"]
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3

        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      liveness_probe {
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3

        http_get {
          path = "/healthz"
          port = 8080
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.taskflow.location
  name     = google_cloud_run_v2_service.taskflow.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_monitoring_alert_policy" "cloud_run_5xx" {
  project      = var.project_id
  display_name = "TaskFlow Cloud Run HTTP 5xx responses"
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "TaskFlow service returns HTTP 5xx responses"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${local.service_name}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"5xx\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "TaskFlow Cloud Run has emitted HTTP 5xx responses for at least one minute. Review Cloud Run request and application logs."
  }

  notification_channels = var.monitoring_notification_channels
}

output "service_url" {
  description = "Public HTTPS URL of the TaskFlow Cloud Run service."
  value       = google_cloud_run_v2_service.taskflow.uri
}

output "artifact_registry_repository" {
  description = "Fully qualified Artifact Registry repository resource name."
  value       = google_artifact_registry_repository.taskflow.name
}

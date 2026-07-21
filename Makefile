# Makefile — convenience targets for the homelab-backstage local dev stack
# See README.md for full usage instructions.

.PHONY: dev-up dev-down dev-clean dev-logs dev-restart install build docker-tags docker-build docker-push publish help

# Docker publish defaults (override in command line or environment)
REGISTRY ?= image-local.int.shaut.us
IMAGE_NAME ?= homelab-backstage
IMAGE ?= $(REGISTRY)/$(IMAGE_NAME)
TAG_SCRIPT ?= ./scripts/docker-tags.sh

# Start the full local dev stack (postgres, keycloak, kafka, airflow, backstage)
dev-up:
	docker compose up -d

# Stop the stack and remove containers (volumes are preserved)
dev-down:
	docker compose down

# Stop the stack and remove volumes (full reset)
dev-clean:
	docker compose down -v

# Tail logs from all services (Ctrl+C to exit)
dev-logs:
	docker compose logs -f

# Restart a single service: make dev-restart svc=backstage
dev-restart:
	docker compose restart $(svc)

# Install Node dependencies locally (for IDE support / running tests outside Docker)
install:
	yarn install

# Print computed Docker tags for the current Git state
docker-tags:
	@$(TAG_SCRIPT)

# Build image with all computed tags (local Docker cache)
docker-build:
	@set -e; \
	TAGS="$$( $(TAG_SCRIPT) )"; \
	if [ -z "$$TAGS" ]; then \
		echo "No tags generated"; exit 1; \
	fi; \
	echo "Building $(IMAGE) with tags:"; \
	echo "$$TAGS" | sed 's/^/  - /'; \
	FIRST_TAG="$$(echo "$$TAGS" | head -n1)"; \
	docker build -t $(IMAGE):$$FIRST_TAG .; \
	echo "$$TAGS" | tail -n +2 | while read -r tag; do \
		docker tag $(IMAGE):$$FIRST_TAG $(IMAGE):$$tag; \
	done

# Push all computed tags
docker-push:
	@set -e; \
	TAGS="$$( $(TAG_SCRIPT) )"; \
	if [ -z "$$TAGS" ]; then \
		echo "No tags generated"; exit 1; \
	fi; \
	echo "Pushing $(IMAGE) tags:"; \
	echo "$$TAGS" | sed 's/^/  - /'; \
	echo "$$TAGS" | while read -r tag; do \
		docker push $(IMAGE):$$tag; \
	done

# Local CI/CD style flow from VS Code terminal
publish: docker-build docker-push

# Backward-compatible target name
build: docker-build

help:
	@echo "Available targets:"
	@echo "  dev-up        Start the full local dev stack"
	@echo "  dev-down      Stop the stack (keep volumes)"
	@echo "  dev-clean     Stop the stack and remove volumes"
	@echo "  dev-logs      Tail logs from all services"
	@echo "  dev-restart   Restart a service: make dev-restart svc=backstage"
	@echo "  install       Install Node deps locally"
	@echo "  docker-tags   Print computed image tags for current Git state"
	@echo "  docker-build  Build Docker image with computed tags"
	@echo "  docker-push   Push all computed tags"
	@echo "  publish       Build and push (local CI/CD flow)"
	@echo "  build         Alias for docker-build"
	@echo ""
	@echo "Variables (override as needed):"
	@echo "  REGISTRY=$(REGISTRY)"
	@echo "  IMAGE_NAME=$(IMAGE_NAME)"
	@echo "  IMAGE=$(IMAGE)"

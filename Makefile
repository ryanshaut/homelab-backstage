# Makefile — convenience targets for the homelab-backstage local dev stack
# See README.md for full usage instructions.

.PHONY: dev-up dev-down dev-logs dev-restart install build help

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

# Build the production Docker image locally
build:
	docker build -t homelab-backstage:local .
	docker tag homelab-backstage:local image-local.int.shaut.us/homelab-backstage:local
	docker push image-local.int.shaut.us/homelab-backstage:local

help:
	@echo "Available targets:"
	@echo "  dev-up        Start the full local dev stack"
	@echo "  dev-down      Stop the stack (keep volumes)"
	@echo "  dev-clean     Stop the stack and remove volumes"
	@echo "  dev-logs      Tail logs from all services"
	@echo "  dev-restart   Restart a service: make dev-restart svc=backstage"
	@echo "  install       Install Node deps locally"
	@echo "  build         Build the production Docker image"

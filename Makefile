GO := go
GOFLAGS := -v
MIGRATE := $(shell which migrate 2>/dev/null || echo "migrate")
DB_URL ?= postgres://foreman:foreman@localhost:5432/foreman?sslmode=disable

.PHONY: all dev infra down migrate migrate-down migrate-create build build-coordinator build-worker test lint clean

all: build

# Start only infra (postgres, redis, minio)
infra:
	docker compose up -d postgres redis minio

# Stop everything
down:
	docker compose down

# Run coordinator locally (requires infra running)
dev: infra
	$(GO) run ./cmd/coordinator

# Run worker locally
worker:
	$(GO) run ./cmd/worker

# Build both binaries
build: build-coordinator build-worker

build-coordinator:
	$(GO) build $(GOFLAGS) -o bin/coordinator ./cmd/coordinator

build-worker:
	$(GO) build $(GOFLAGS) -o bin/worker ./cmd/worker

# DB migrations (requires golang-migrate: go install github.com/golang-migrate/migrate/v4/cmd/migrate@latest)
migrate:
	migrate -path migrations -database "$(DB_URL)" up

migrate-down:
	migrate -path migrations -database "$(DB_URL)" down

migrate-create:
	@read -p "Migration name: " name; \
	migrate create -ext sql -dir migrations -seq $$name

# Run tests
test:
	$(GO) test ./... -race -timeout 30s

# Lint (requires golangci-lint)
lint:
	golangci-lint run ./...

# Tidy dependencies
tidy:
	$(GO) mod tidy

clean:
	rm -rf bin/

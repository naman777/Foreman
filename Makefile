.PHONY: up down infra migrate build test smoke

up:
	docker compose up -d --build

down:
	docker compose down

infra:
	docker compose up -d postgres redis minio

migrate:
	docker compose run --rm migrate

build:
	npm --prefix node/coordinator run build
	npm --prefix node/worker run build
	npm --prefix dashboard run build

test:
	npm --prefix node/coordinator test
	npm --prefix node/worker test

smoke:
	node scripts/node-smoke.mjs

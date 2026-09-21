up:
	docker compose up -d --build --remove-orphans

down:
	docker compose down --remove-orphans

restart: down up

log:
	docker compose logs -f

#!/bin/bash
set -euo pipefail

PORT="${SYNC_DAEMON_PORT:-3001}"
PG_CONTAINER="${AGENT_MEMORY_PG_CONTAINER:-jesus-postgres}"
PG_IMAGE="${AGENT_MEMORY_PG_IMAGE:-postgres:16}"
DB_HOST="${AGENT_MEMORY_DB_HOST:-127.0.0.1}"
DB_PORT="${AGENT_MEMORY_DB_PORT:-5432}"
DB_NAME="${AGENT_MEMORY_DB_NAME:-agent_memory}"
DB_USER="${AGENT_MEMORY_DB_USER:-postgres}"
DB_PASSWORD="${AGENT_MEMORY_DB_PASSWORD:-postgres}"

is_port_open() {
  local host="$1"
  local port="$2"

  if command -v nc >/dev/null 2>&1; then
    # macOS/BSD nc uses -G for connect timeout; GNU/netcat-openbsd often use -w.
    nc -z -G 1 "$host" "$port" >/dev/null 2>&1 && return 0
    nc -z -w 1 "$host" "$port" >/dev/null 2>&1 && return 0
  fi

  # Fallback: bash TCP redirection
  (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1 && return 0

  return 1
}

docker_cmd() {
  local timeout_s="${AGENT_MEMORY_DOCKER_TIMEOUT_SEC:-30}"
  docker "$@" &
  local pid=$!
  local waited=0

  while kill -0 "$pid" >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout_s" ]; then
      kill -9 "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      echo "Docker command timed out after ${timeout_s}s: docker $*" >&2
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done

  wait "$pid"
}

ensure_postgres() {
  if is_port_open "$DB_HOST" "$DB_PORT"; then
    echo "PostgreSQL already reachable at ${DB_HOST}:${DB_PORT}"
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "PostgreSQL is not reachable and Docker is not installed."
    echo "Install Docker or start a local Postgres instance on ${DB_HOST}:${DB_PORT}."
    exit 1
  fi

  if ! docker_cmd info >/dev/null 2>&1; then
    echo "Docker daemon is not running."
    echo "Start Docker Desktop and re-run this command."
    exit 1
  fi

  if docker_cmd ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
    echo "PostgreSQL container (${PG_CONTAINER}) already running"
  elif docker_cmd ps -a --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
    echo "Starting PostgreSQL container (${PG_CONTAINER})..."
    docker_cmd start "${PG_CONTAINER}" >/dev/null
  else
    echo "Creating PostgreSQL container (${PG_CONTAINER})..."
    docker_cmd run -d \
      --name "${PG_CONTAINER}" \
      -e POSTGRES_USER="${DB_USER}" \
      -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
      -e POSTGRES_DB="${DB_NAME}" \
      -p "${DB_PORT}:5432" \
      "${PG_IMAGE}" >/dev/null
  fi

  echo "Waiting for PostgreSQL on ${DB_HOST}:${DB_PORT}..."
  for _ in $(seq 1 30); do
    if is_port_open "$DB_HOST" "$DB_PORT"; then
      echo "PostgreSQL is ready"
      return
    fi
    sleep 1
  done

  echo "PostgreSQL did not become ready in time."
  exit 1
}

# 1. Kill existing process on daemon port
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Killing existing process on port $PORT..."
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 2. Resolve database target
if [ -n "${DATABASE_URL:-}" ]; then
  echo "Using explicit DATABASE_URL; skipping local Postgres auto-start."
else
  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  # 3. Ensure PostgreSQL is reachable (local/dev fallback)
  ensure_postgres
fi

# 4. Run migrations before daemon boot
echo "Running migrations..."
bun run scripts/migrate.ts

# Optional: database bootstrap only
if [ "${AGENT_MEMORY_DB_ONLY:-0}" = "1" ]; then
  echo "Database bootstrap complete (AGENT_MEMORY_DB_ONLY=1)."
  exit 0
fi

# 5. Start daemon
echo "Starting daemon..."
exec bun run scripts/sync-daemon.ts

#!/bin/bash
set -e

PORT=3001
PG_CONTAINER="jesus-postgres"  # Use the root docker-compose postgres

# 1. Kill existing process on port
if lsof -ti:$PORT >/dev/null 2>&1; then
  echo "Killing existing process on port $PORT..."
  lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 2. Start PostgreSQL if not running
if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  echo "PostgreSQL container ($PG_CONTAINER) already running"
elif docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  echo "Starting PostgreSQL container ($PG_CONTAINER)..."
  docker start $PG_CONTAINER
  echo "Waiting for PostgreSQL..."
  sleep 3
else
  echo "PostgreSQL container not found. Run 'docker compose up -d postgres' from project root."
  exit 1
fi

# 3. Start daemon
echo "Starting daemon..."
exec bun run scripts/sync-daemon.ts

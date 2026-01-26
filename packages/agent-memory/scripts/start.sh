#!/bin/bash
set -e

PORT=3001
PG_CONTAINER="agent-memory-pg"

# 1. Kill existing process on port
if lsof -ti:$PORT >/dev/null 2>&1; then
  echo "Killing existing process on port $PORT..."
  lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 2. Start PostgreSQL if not running
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    echo "Starting existing PostgreSQL container..."
    docker start $PG_CONTAINER
  else
    echo "Creating PostgreSQL container..."
    docker run -d \
      --name $PG_CONTAINER \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=agent_memory \
      -p 5432:5432 \
      pgvector/pgvector:pg16
  fi
  echo "Waiting for PostgreSQL..."
  sleep 3
else
  echo "PostgreSQL already running"
fi

# 3. Start daemon
echo "Starting daemon..."
exec bun run scripts/sync-daemon.ts

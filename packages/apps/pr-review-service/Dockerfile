FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN bun install --frozen-lockfile

EXPOSE 8080

CMD ["bun", "run", "--cwd", "packages/apps/pr-review-service", "start"]

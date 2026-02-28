#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Idempotently configure GitHub webhooks for PR review.

Usage:
  setup-pr-review-webhooks.sh --owner <org-or-user> --repo <repo> --webhook-url <url> --webhook-secret <secret> [options]
  setup-pr-review-webhooks.sh --owner <org-or-user> --all-repos --webhook-url <url> --webhook-secret <secret> [options]

Options:
  --owner <name>             GitHub org/user owner (required)
  --repo <name>              Single repository name
  --all-repos                Apply to all non-archived repos for --owner
  --webhook-url <url>        Webhook endpoint URL (required)
  --webhook-secret <secret>  Webhook secret (required)
  --hostname <host>          GitHub hostname (default: github.com)
  --dry-run                  Print planned changes without applying
  -h, --help                 Show this help

Examples:
  ./scripts/setup-pr-review-webhooks.sh \
    --owner your-org \
    --repo your-repo \
    --webhook-url https://review.example.com/webhooks/github \
    --webhook-secret "$GITHUB_WEBHOOK_SECRET"

  ./scripts/setup-pr-review-webhooks.sh \
    --owner your-org \
    --all-repos \
    --webhook-url https://review.example.com/webhooks/github \
    --webhook-secret "$GITHUB_WEBHOOK_SECRET"
EOF
}

OWNER=""
REPO=""
ALL_REPOS=0
WEBHOOK_URL=""
WEBHOOK_SECRET=""
HOSTNAME="github.com"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --all-repos)
      ALL_REPOS=1
      shift
      ;;
    --webhook-url)
      WEBHOOK_URL="${2:-}"
      shift 2
      ;;
    --webhook-secret)
      WEBHOOK_SECRET="${2:-}"
      shift 2
      ;;
    --hostname)
      HOSTNAME="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$OWNER" ]]; then
  echo "--owner is required" >&2
  usage
  exit 1
fi
if [[ -z "$WEBHOOK_URL" ]]; then
  echo "--webhook-url is required" >&2
  usage
  exit 1
fi
if [[ -z "$WEBHOOK_SECRET" ]]; then
  echo "--webhook-secret is required" >&2
  usage
  exit 1
fi
if [[ -n "$REPO" && "$ALL_REPOS" -eq 1 ]]; then
  echo "Use either --repo or --all-repos, not both" >&2
  usage
  exit 1
fi
if [[ -z "$REPO" && "$ALL_REPOS" -ne 1 ]]; then
  echo "You must provide either --repo or --all-repos" >&2
  usage
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required but not found" >&2
  exit 1
fi

gh_api() {
  if [[ "$HOSTNAME" == "github.com" ]]; then
    gh api "$@"
  else
    gh api --hostname "$HOSTNAME" "$@"
  fi
}

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

create_hook() {
  local owner="$1"
  local repo="$2"
  gh_api -X POST "repos/$owner/$repo/hooks" \
    -f name='web' \
    -F active=true \
    -f 'events[]=pull_request' \
    -f "config[url]=$WEBHOOK_URL" \
    -f "config[secret]=$WEBHOOK_SECRET" \
    -f 'config[content_type]=json' \
    -f 'config[insecure_ssl]=0' \
    --silent
}

update_hook() {
  local owner="$1"
  local repo="$2"
  local hook_id="$3"
  gh_api -X PATCH "repos/$owner/$repo/hooks/$hook_id" \
    -F active=true \
    -f 'events[]=pull_request' \
    -f "config[url]=$WEBHOOK_URL" \
    -f "config[secret]=$WEBHOOK_SECRET" \
    -f 'config[content_type]=json' \
    -f 'config[insecure_ssl]=0' \
    --silent
}

delete_hook() {
  local owner="$1"
  local repo="$2"
  local hook_id="$3"
  gh_api -X DELETE "repos/$owner/$repo/hooks/$hook_id" --silent
}

resolve_target_repos() {
  if [[ -n "$REPO" ]]; then
    printf '%s\n' "$REPO"
    return
  fi
  gh_api "orgs/$OWNER/repos?per_page=100" --paginate --jq '.[] | select(.archived == false) | .name'
}

created=0
updated=0
deleted=0
failed=0

mapfile -t REPOS < <(resolve_target_repos)
if [[ "${#REPOS[@]}" -eq 0 ]]; then
  echo "No repositories found for owner=$OWNER" >&2
  exit 1
fi

echo "Target repos: ${#REPOS[@]}"
echo "Webhook URL: $WEBHOOK_URL"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Mode: dry-run (no changes applied)"
fi

for repo in "${REPOS[@]}"; do
  echo ""
  echo "[$OWNER/$repo]"

  if ! mapfile -t HOOK_ROWS < <(gh_api "repos/$OWNER/$repo/hooks?per_page=100" --paginate --jq '.[] | select(.name == "web") | "\(.id)\t\(.config.url // "")"' 2>/dev/null); then
    echo "  ERROR: unable to list hooks"
    failed=$((failed + 1))
    continue
  fi

  MATCHING_IDS=()
  for row in "${HOOK_ROWS[@]}"; do
    hook_id="${row%%$'\t'*}"
    hook_url="${row#*$'\t'}"
    if [[ "$hook_url" == "$WEBHOOK_URL" ]]; then
      MATCHING_IDS+=("$hook_id")
    fi
  done

  if [[ "${#MATCHING_IDS[@]}" -eq 0 ]]; then
    echo "  create webhook"
    if [[ "$DRY_RUN" -ne 1 ]]; then
      if create_hook "$OWNER" "$repo"; then
        created=$((created + 1))
      else
        echo "  ERROR: create failed"
        failed=$((failed + 1))
        continue
      fi
    fi
    continue
  fi

  primary_id="${MATCHING_IDS[0]}"
  echo "  update existing webhook id=$primary_id"
  if [[ "$DRY_RUN" -ne 1 ]]; then
    if update_hook "$OWNER" "$repo" "$primary_id"; then
      updated=$((updated + 1))
    else
      echo "  ERROR: update failed"
      failed=$((failed + 1))
      continue
    fi
  fi

  if [[ "${#MATCHING_IDS[@]}" -gt 1 ]]; then
    extras=("${MATCHING_IDS[@]:1}")
    for extra_id in "${extras[@]}"; do
      echo "  delete duplicate webhook id=$extra_id"
      if [[ "$DRY_RUN" -ne 1 ]]; then
        if delete_hook "$OWNER" "$repo" "$extra_id"; then
          deleted=$((deleted + 1))
        else
          echo "  ERROR: delete duplicate failed id=$extra_id"
          failed=$((failed + 1))
        fi
      fi
    done
  fi
done

echo ""
echo "Done."
echo "created=$created updated=$updated deleted_duplicates=$deleted failed=$failed"
if [[ "$failed" -gt 0 ]]; then
  exit 1
fi

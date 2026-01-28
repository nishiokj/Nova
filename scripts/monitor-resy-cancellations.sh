#!/bin/bash
# Valentine's Day Resy Cancellation Monitor
# Runs periodically to check for newly opened tables

TARGET_DATE="2026-02-14"
PARTY_SIZE=2
STATE_FILE="./auth-states/resy-auth.json"
CHECK_INTERVAL=300  # Check every 5 minutes (in seconds)
LOG_FILE="/tmp/resy-monitor.log"
ALERT_FILE="/tmp/resy-alerts.txt"

# Target restaurants to monitor
declare -a MONITOR_RESTAURANTS=(
  "https://resy.com/cities/chicago-il/venues/bavettes-bar-and-boeuf"
  "https://resy.com/cities/chicago-il/venues/gilt-bar"
  "https://resy.com/cities/chicago-il/venues/ciccio-mio"
  "https://resy.com/cities/chicago-il/venues/trivoli-tavern"
  "https://resy.com/cities/chicago-il/venues/giant"
  "https://resy.com/cities/chicago-il/venues/monteverde-restaurant-and-pastificio"
  "https://resy.com/cities/chicago-il/venues/kasama"
  "https://resy.com/cities/chicago-il/venues/kyoten-next"
  "https://resy.com/cities/chicago-il/venues/armitage-alehouse"
)

# Initialize alert file
echo "VALentine's Day Reservation Alerts" > "$ALERT_FILE"
echo "Started: $(date)" >> "$ALERT_FILE"
echo "" >> "$ALERT_FILE"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

send_alert() {
  local restaurant="$1"
  local slots="$2"
  local url="$3"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  log "🎉 ALERT: $restaurant has availability!"
  log "   Slots: $slots"
  log "   URL: $url"

  # Add to alert file
  echo "[$timestamp]" >> "$ALERT_FILE"
  echo "Restaurant: $restaurant" >> "$ALERT_FILE"
  echo "Available Slots: $slots" >> "$ALERT_FILE"
  echo "Book Now: $url" >> "$ALERT_FILE"
  echo "" >> "$ALERT_FILE"

  # Try to send notification (macOS)
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$restaurant has Valentine's Day tables available! $slots\" with title \"🍽️ Resy Alert\""
  fi

  # Try to send terminal bell
  printf '\a'
}

check_restaurant() {
  local url="$1"
  local slug=$(echo "$url" | sed 's|.*/venues/||')

  log "Checking: $slug"

  # Open restaurant page
  agent-browser --session resy-monitor --state "$STATE_FILE" open "${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}" >/dev/null 2>&1
  sleep 2

  # Get page text
  local page_text=$(agent-browser --session resy-monitor eval "document.body.innerText" 2>/dev/null || echo "")

  # Check for availability (time slot buttons)
  if echo "$page_text" | grep -qE "(\d{1,2}:\d{2}\s*(AM|PM)).*(Dining Room|Patio|Brunch|Lunch|First Available|Bar)"; then
    # Extract available time slots
    local slots=$(echo "$page_text" | grep -oE "\d{1,2}:\d{2}\s*(AM|PM)" | head -5 | tr '\n' ',' | sed 's/,$//')

    if [ -n "$slots" ]; then
      # Get restaurant name
      local name=$(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')

      # Check if we've already alerted for this
      if ! grep -q "$name" "$ALERT_FILE" 2>/dev/null || [ $(grep -c "$name" "$ALERT_FILE" 2>/dev/null || echo 0) -lt 5 ]; then
        send_alert "$name" "$slots" "$url"
      fi
    fi
  fi
}

# Main monitoring loop
log "🚀 Starting Valentine's Day reservation monitor"
log "📅 Date: $TARGET_DATE"
log "👥 Party Size: $PARTY_SIZE"
log "⏱️  Check Interval: ${CHECK_INTERVAL}s"
log "📋 Monitoring ${#MONITOR_RESTAURANTS[@]} restaurants"
log ""

trap "agent-browser --session resy-monitor close >/dev/null 2>&1; log '🛑 Monitor stopped'; exit 0" INT TERM

while true; do
  log "════════════════════════════════════════════════════════════"

  for url in "${MONITOR_RESTAURANTS[@]}"; do
    check_restaurant "$url"
  done

  log "════════════════════════════════════════════════════════════"
  log "⏳ Next check in ${CHECK_INTERVAL}s... (Press Ctrl+C to stop)"

  sleep "$CHECK_INTERVAL"
done

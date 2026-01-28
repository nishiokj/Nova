#!/bin/bash
# Valentine's Day Reservation Checker
# Checks availability for 2 people on Feb 14, 2026 at top Chicago restaurants

TARGET_DATE="2026-02-14"
PARTY_SIZE=2
RESULTS_FILE="/tmp/valentine-restaurants.json"

echo "🍽️  Valentine's Day Restaurant Availability Checker"
echo "📅 Date: $TARGET_DATE ($PARTY_SIZE people)"
echo "📍 Target Neighborhoods: Lakeview, West Loop, River North"
echo ""

# Array of top restaurants to check
declare -a RESTAURANTS=(
  "https://resy.com/cities/chicago-il/venues/the-duck-inn"
  "https://resy.com/cities/chicago-il/venues/monteverde-restaurant-and-pastificio"
  "https://resy.com/cities/chicago-il/venues/gilt-bar"
  "https://resy.com/cities/chicago-il/venues/bavettes-bar-and-boeuf"
  "https://resy.com/cities/chicago-il/venues/kasama"
  "https://resy.com/cities/chicago-il/venues/kyoten-next"
  "https://resy.com/cities/chicago-il/venues/trivoli-tavern"
  "https://resy.com/cities/chicago-il/venues/ciccio-mio"
  "https://resy.com/cities/chicago-il/venues/armitage-alehouse"
  "https://resy.com/cities/chicago-il/venues/gemini"
)

mkdir -p /tmp/valentine-checks

# Initialize results JSON
echo '{"restaurants":[]}' > "$RESULTS_FILE"

for url in "${RESTAURANTS[@]}"; do
  echo "Checking: $url"

  # Extract restaurant slug for filename
  slug=$(echo "$url" | sed 's|.*/venues/||')
  venue_file="/tmp/valentine-checks/${slug}.txt"

  # Open restaurant page
  agent-browser --session valentine-check --state ./auth-states/resy-auth.json open "${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}" >/dev/null 2>&1
  sleep 2

  # Get page text
  agent-browser --session valentine-check eval "document.body.innerText" > "$venue_file" 2>/dev/null

  # Extract neighborhood and availability
  neighborhood=$(grep -oP '(?<=\n\n\n)[A-Z][a-z]+(?: [A-Z][a-z]+)*(?=\n\n\n)' "$venue_file" | head -1 || echo "Unknown")

  # Check if in target area
  is_target=false
  if echo "$neighborhood" | grep -qiE "(lakeview|west loop|river north|riverwest|fulton market|streeterville|near north)"; then
    is_target=true
  fi

  # Check for availability (time slots)
  if grep -qE "(\d{1,2}:\d{2}\s*(AM|PM)).*(Dining Room|Patio|Brunch|Lunch|First Available|Bar)" "$venue_file"; then
    status="AVAILABLE"
    slots=$(grep -oE "\d{1,2}:\d{2}\s*(AM|PM)" "$venue_file" | head -5 | tr '\n' ',' | sed 's/,$//')
  else
    status="FULL"
    slots=""
  fi

  if [ "$is_target" = true ]; then
    if [ "$status" = "AVAILABLE" ]; then
      echo "  ✅ AVAILABLE - $(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1') ($neighborhood)"
      echo "     Slots: $slots"
    else
      echo "  ❌ FULL - $(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1') ($neighborhood)"
    fi
  else
    echo "  ⏭️  Skipped - $(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1') ($neighborhood)"
  fi
done

# Close browser
agent-browser --session valentine-check close >/dev/null 2>&1

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Next steps:"
echo "  1. Review restaurants marked AVAILABLE"
echo "  2. Use ./setup-resy-notifications.sh to set up notifications for FULL restaurants"
echo "  3. Monitor for cancellations in the next few days"
echo "════════════════════════════════════════════════════════════"

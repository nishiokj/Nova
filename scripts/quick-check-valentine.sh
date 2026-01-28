#!/bin/bash
# Quick Valentine's Day Availability Check
# One-time check of current availability

TARGET_DATE="2026-02-14"
PARTY_SIZE=2
STATE_FILE="./auth-states/resy-auth.json"

echo "🍽️  Valentine's Day Quick Availability Check"
echo "📅 Date: $TARGET_DATE ($PARTY_SIZE people)"
echo "📍 Target: Lakeview, West Loop, River North"
echo ""

# Key restaurants in target neighborhoods
declare -a RESTAURANTS=(
  "bavettes-bar-and-boeuf:River North:Bavette's Bar & Boeuf"
  "gilt-bar:River North:Gilt Bar"
  "ciccio-mio:River North:Ciccio Mio"
  "trivoli-tavern:West Loop:Trivoli Tavern"
  "giant:West Loop:Giant"
)

AVAILABLE_COUNT=0

for restaurant_info in "${RESTAURANTS[@]}"; do
  IFS=':' read -r slug neighborhood name <<< "$restaurant_info"
  url="https://resy.com/cities/chicago-il/venues/${slug}"

  echo -n "Checking $name... "

  # Open restaurant page
  agent-browser --session quick-check --state "$STATE_FILE" open "${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}" >/dev/null 2>&1
  sleep 2

  # Get page text
  page_text=$(agent-browser --session quick-check eval "document.body.innerText" 2>/dev/null || echo "")

  # Check for availability
  if echo "$page_text" | grep -qE "(\d{1,2}:\d{2}\s*(AM|PM)).*(Dining Room|Patio|Brunch|Lunch|First Available|Bar)"; then
    # Extract time slots
    slots=$(echo "$page_text" | grep -oE "\d{1,2}:\d{2}\s*(AM|PM)" | head -3 | tr '\n' ',' | sed 's/,$//')

    if [ -n "$slots" ]; then
      echo "✅ AVAILABLE"
      echo "   🕐 Slots: $slots"
      echo "   🔗 Book: ${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}"
      ((AVAILABLE_COUNT++))
    else
      echo "❌ Full"
    fi
  else
    echo "❌ Full"
  fi

  echo ""
done

# Close browser
agent-browser --session quick-check close >/dev/null 2>&1

echo "════════════════════════════════════════════════════════════"
echo "Summary: $AVAILABLE_COUNT restaurants with availability"
echo ""
echo "Next steps:"
if [ "$AVAILABLE_COUNT" -gt 0 ]; then
  echo "  1. Book immediately - reservations go fast!"
else
  echo "  1. Run: ./setup-resy-notifications.sh"
  echo "  2. Run: ./monitor-resy-cancellations.sh (in background)"
  echo "  3. Watch for notifications/alerts"
fi
echo "════════════════════════════════════════════════════════════"

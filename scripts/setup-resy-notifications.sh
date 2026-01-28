#!/bin/bash
# Valentine's Day Resy Notification Setup
# Sets up notifications for top restaurants in target neighborhoods

TARGET_DATE="2026-02-14"
PARTY_SIZE=2
STATE_FILE="./auth-states/resy-auth.json"

echo "🍽️  Setting up Resy notifications for Valentine's Day"
echo "📅 Date: $TARGET_DATE ($PARTY_SIZE people)"
echo ""

# Restaurants in target neighborhoods (Lakeview, West Loop, River North)
declare -a TARGET_RESTAURANTS=(
  "https://resy.com/cities/chicago-il/venues/bavettes-bar-and-boeuf"        # River North
  "https://resy.com/cities/chicago-il/venues/gilt-bar"                        # River North
  "https://resy.com/cities/chicago-il/venues/ciccio-mio"                       # River North
  "https://resy.com/cities/chicago-il/venues/trivoli-tavern"                   # West Loop
  "https://resy.com/cities/chicago-il/venues/giant"                            # West Loop
)

# Additional highly-rated restaurants (check for neighborhood)
declare -a OTHER_TOP_RESTAURANTS=(
  "https://resy.com/cities/chicago-il/venues/monteverde-restaurant-and-pastificio"
  "https://resy.com/cities/chicago-il/venues/kasama"
  "https://resy.com/cities/chicago-il/venues/kyoten-next"
  "https://resy.com/cities/chicago-il/venues/armitage-alehouse"
  "https://resy.com/cities/chicago-il/venues/gemini"
)

echo "📍 Setting up notifications for TARGET NEIGHBORHOOD restaurants:"
for url in "${TARGET_RESTAURANTS[@]}"; do
  slug=$(echo "$url" | sed 's|.*/venues/||')
  echo "  • $(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"
done

echo ""
echo "🔔 Notification Setup Instructions:"
echo ""
echo "Each restaurant page has a 'Notify' button. This script will:"
echo "1. Open each restaurant page"
echo "2. Look for the 'Notify' button"
echo "3. You'll need to manually click 'Notify' to set up notifications"
echo ""
echo "Resy will send you a notification/email when a table opens up."
echo ""
echo "⏳ Opening restaurants one by one..."

for url in "${TARGET_RESTAURANTS[@]}"; do
  slug=$(echo "$url" | sed 's|.*/venues/||')
  echo ""
  echo "Opening: $(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"

  # Open restaurant page
  agent-browser --session notify-setup --state "$STATE_FILE" open "${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}" >/dev/null 2>&1
  sleep 2

  # Check if there's a Notify button
  has_notify=$(agent-browser --session notify-setup eval "document.body.innerText.includes('Notify')" 2>/dev/null || echo "false")

  if [ "$has_notify" = "true" ]; then
    echo "  🔔 Notify button found! Please click it to set up notification."
    echo "     Press ENTER when you've set up the notification..."
    read -r
  else
    echo "  ⚠️  No Notify button - may have availability or different page layout"
  fi
done

# Also check other top restaurants
echo ""
echo "📍 Checking other top-rated restaurants..."
for url in "${OTHER_TOP_RESTAURANTS[@]}"; do
  slug=$(echo "$url" | sed 's|.*/venues/||')

  # Open restaurant page
  agent-browser --session notify-setup open "${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}" >/dev/null 2>&1
  sleep 2

  # Get neighborhood
  neighborhood=$(agent-browser --session notify-setup eval "
    const text = document.body.innerText;
    const match = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\n\n\nShare/);
    return match ? match[1] : 'Unknown';
  " 2>/dev/null || echo "Unknown")

  # Check if in target area
  if echo "$neighborhood" | grep -qiE "(lakeview|west loop|river north|riverwest|fulton market)"; then
    echo "  ✅ $(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1') ($neighborhood)"
    echo "     Opening page for notification setup..."

    has_notify=$(agent-browser --session notify-setup eval "document.body.innerText.includes('Notify')" 2>/dev/null || echo "false")
    if [ "$has_notify" = "true" ]; then
      echo "     🔔 Notify button found! Please click it."
      echo "     Press ENTER to continue..."
      read -r
    fi
  fi
done

agent-browser --session notify-setup close >/dev/null 2>&1

echo ""
echo "════════════════════════════════════════════════════════════"
echo "✅ Notification setup complete!"
echo ""
echo "Next steps:"
echo "  1. Watch your email for Resy notifications"
echo "  2. When you get a notification, act FAST - reservations go quickly"
echo "  3. Run ./monitor-resy-cancellations.sh to periodically check for new openings"
echo "════════════════════════════════════════════════════════════"

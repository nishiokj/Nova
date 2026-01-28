#!/usr/bin/env tsx
/**
 * Valentine's Day Reservation Checker
 *
 * Checks availability for 2 people on Feb 14, 2026 at top Chicago restaurants
 * in Lakeview, West Loop, and River North neighborhoods.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

const TARGET_NEIGHBORHOODS = ['Lakeview', 'West Loop', 'River North', 'Riverwest', 'Fulton Market', 'Streeterville', 'Near North Side'];
const TARGET_DATE = '2026-02-14';
const PARTY_SIZE = 2;

const TOP_RESTAURANTS = [
  'https://resy.com/cities/chicago-il/venues/the-duck-inn',
  'https://resy.com/cities/chicago-il/venues/un-amor',
  'https://resy.com/cities/chicago-il/venues/space-519-the-lunchroom',
  'https://resy.com/cities/chicago-il/venues/segnatore',
  'https://resy.com/cities/chicago-il/venues/ascione-bistro',
  'https://resy.com/cities/chicago-il/venues/gemini',
  'https://resy.com/cities/chicago-il/venues/denuccis',
  'https://resy.com/cities/chicago-il/venues/lardon',
  'https://resy.com/cities/chicago-il/venues/monteverde-restaurant-and-pastificio',
  'https://resy.com/cities/chicago-il/venues/trivoli-tavern',
  'https://resy.com/cities/chicago-il/venues/ciccio-mio',
  'https://resy.com/cities/chicago-il/venues/gilt-bar',
  'https://resy.com/cities/chicago-il/venues/bavettes-bar-and-boeuf',
  'https://resy.com/cities/chicago-il/venues/petit-pomeroy',
  'https://resy.com/cities/chicago-il/venues/kasama',
  'https://resy.com/cities/chicago-il/venues/kyoten-next',
  'https://resy.com/cities/chicago-il/venues/armitage-alehouse',
  'https://resy.com/cities/chicago-il/venues/giant',
];

interface RestaurantInfo {
  name: string;
  url: string;
  neighborhood: string;
  inTargetArea: boolean;
  hasAvailability: boolean;
  availableSlots: string[];
}

function isInTargetArea(neighborhood: string): boolean {
  const normalized = neighborhood.toLowerCase();
  return TARGET_NEIGHBORHOODS.some(area =>
    normalized.includes(area.toLowerCase())
  );
}

async function checkRestaurantWithBrowser(url: string): Promise<RestaurantInfo | null> {
  try {
    // Open the restaurant page with auth state
    execSync(`agent-browser --session valentine-check open "${url}?date=${TARGET_DATE}&seats=${PARTY_SIZE}"`, { encoding: 'utf8' });

    // Wait for page load
    execSync('sleep 2', { encoding: 'utf8' });

    // Extract restaurant name and neighborhood
    const info = execSync(`agent-browser --session valentine-check eval "document.body.innerText"`, { encoding: 'utf8' });

    // Parse neighborhood from page
    const neighborhoodMatch = info.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\n\n\nShare/i);
    const neighborhood = neighborhoodMatch ? neighborhoodMatch[1] : 'Unknown';

    // Extract restaurant name (usually first line with stars)
    const nameMatch = info.match(/^([^\n]+)\n\n/i);
    const name = nameMatch ? nameMatch[1].trim() : url.split('/').pop()?.replace(/-/g, ' ') || 'Unknown';

    // Check for availability - look for time slot buttons
    const hasTimeSlots = /(\d{1,2}:\d{2}\s*(?:AM|PM))\s*(?:Dining Room|Patio|Brunch|Lunch|First Available|Bar)/i.test(info);
    const hasNotifyOnly = info.includes('Notify') && !hasTimeSlots;

    // Extract available time slots
    const timeSlotMatches = info.matchAll(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*(?:Dining Room|Patio|Brunch|Lunch|First Available|Bar)/gi);
    const availableSlots = Array.from(timeSlotMatches).map(m => m[1]).slice(0, 10);

    return {
      name,
      url,
      neighborhood,
      inTargetArea: isInTargetArea(neighborhood),
      hasAvailability: hasTimeSlots,
      availableSlots,
    };
  } catch (error) {
    console.error(`Error checking ${url}:`, error);
    return null;
  }
}

async function main() {
  console.log('🍽️  Valentine\'s Day Restaurant Availability Checker');
  console.log(`📅 Date: ${TARGET_DATE} (${PARTY_SIZE} people)`);
  console.log(`📍 Target Neighborhoods: ${TARGET_NEIGHBORHOODS.join(', ')}`);
  console.log('');

  const results: RestaurantInfo[] = [];
  const targetAreaResults: RestaurantInfo[] = [];

  for (const url of TOP_RESTAURANTS) {
    console.log(`Checking: ${url}`);
    const info = await checkRestaurantWithBrowser(url);

    if (info) {
      results.push(info);

      if (info.inTargetArea) {
        targetAreaResults.push(info);
        const status = info.hasAvailability ? '✅ AVAILABLE' : '❌ FULL';
        console.log(`  ${status} - ${info.name} (${info.neighborhood})`);
        if (info.availableSlots.length > 0) {
          console.log(`     Slots: ${info.availableSlots.slice(0, 5).join(', ')}`);
        }
      } else {
        console.log(`  ⏭️  Skipped - ${info.name} (${info.neighborhood})`);
      }
    }
  }

  // Close browser
  try {
    execSync('agent-browser --session valentine-check close', { encoding: 'utf8' });
  } catch (e) {
    // Ignore errors
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`📍 Restaurants in target areas: ${targetAreaResults.length}`);
  console.log(`✅ With availability: ${targetAreaResults.filter(r => r.hasAvailability).length}`);
  console.log(`❌ Full (Notify only): ${targetAreaResults.filter(r => !r.hasAvailability).length}`);
  console.log('');

  if (targetAreaResults.some(r => r.hasAvailability)) {
    console.log('🎉 AVAILABLE RESTAURANTS:');
    targetAreaResults.filter(r => r.hasAvailability).forEach(r => {
      console.log(`  • ${r.name} (${r.neighborhood})`);
      console.log(`    ${r.availableSlots.slice(0, 3).join(', ')}${r.availableSlots.length > 3 ? '...' : ''}`);
      console.log(`    ${r.url}`);
    });
  } else {
    console.log('⚠️  No availability found. Setting up notifications...');
    console.log('');
    console.log('🔔 RESTAURANTS TO SET UP NOTIFICATIONS FOR:');
    targetAreaResults.filter(r => !r.hasAvailability).forEach(r => {
      console.log(`  • ${r.name} (${r.neighborhood})`);
      console.log(`    ${r.url}`);
    });
  }

  console.log('');
  console.log('💾 Saving results to /tmp/valentine-restaurants.json');

  fs.writeFileSync(
    '/tmp/valentine-restaurants.json',
    JSON.stringify({ targetAreaResults, allResults: results }, null, 2)
  );
}

main().catch(console.error);

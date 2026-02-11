const fs = require('fs');
const path = require('path');

// Telegram bot token (should be in environment or config)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Get chat_id from user
async function getChatId() {
  // Read sessions if they exist
  const sessionsPath = '/Users/jevinnishioka/Desktop/jesus/packages/plugins/agent-memory/data/telegram-sessions.json';
  if (fs.existsSync(sessionsPath)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const chatIds = Object.keys(sessions);
    if (chatIds.length > 0) {
      console.log('Found sessions for chat IDs:', chatIds);
      return chatIds[0];
    }
  }
  return null;
}

// Send photo to Telegram
async function sendPhoto(chatId, imagePath, caption) {
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  
  try {
    await bot.sendPhoto(chatId, imagePath, { caption });
    console.log('Photo sent successfully!');
    return true;
  } catch (err) {
    console.error('Error sending photo:', err.message);
    return false;
  }
}

// Main
async function main() {
  const imagePaths = [
    '/Users/jevinnishioka/Desktop/jesus/node_modules/playwright-core/lib/server/chromium/appIcon.png',
    '/Users/jevinnishioka/Desktop/jesus/context-engineering-research-2025-01-26/sources/source-01/screenshot.png',
  ];
  
  console.log('This script requires your Telegram chat ID.');
  console.log('To get your chat ID, try sending a message to @userinfobot on Telegram');
  console.log('');
  console.log('Then run: TELEGRAM_BOT_TOKEN=your_token node send_image_telegram.js YOUR_CHAT_ID');
}

main();

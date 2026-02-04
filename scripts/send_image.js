const fs = require('fs');
const https = require('https');

// Your Telegram credentials
const BOT_TOKEN = '8536013022:AAH3OSJivXFlM3x4KOqBaViE7YDfucyCel0';
const CHAT_ID = '7844033096';

// Image to send
const IMAGE_PATH = '/Users/jevinnishioka/Desktop/jesus/node_modules/playwright-core/lib/server/chromium/appIcon.png';
const CAPTION = 'Here\'s the Playwright Chromium icon from your /jesus directory!';

function sendPhoto() {
  // Read the image file
  const imageBuffer = fs.readFileSync(IMAGE_PATH);
  
  // Create multipart/form-data boundary
  const boundary = '----TelegramFormBoundary' + Date.now();
  
  // Build the multipart/form-data body
  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="chat_id"\r\n\r\n`,
    `${CHAT_ID}\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="photo"; filename="appIcon.png"\r\n`,
    `Content-Type: image/png\r\n\r\n`,
    imageBuffer,
    `\r\n--${boundary}\r\n`,
    `Content-Disposition: form-data; name="caption"\r\n\r\n`,
    `${CAPTION}\r\n`,
    `--${boundary}--\r\n`
  ];
  
  // Calculate content length
  let contentLength = 0;
  parts.forEach(part => {
    if (Buffer.isBuffer(part)) {
      contentLength += part.length;
    } else {
      contentLength += Buffer.byteLength(part);
    }
  });
  
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${BOT_TOKEN}/sendPhoto`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': contentLength
    }
  };
  
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log('Response:', data);
      const response = JSON.parse(data);
      if (response.ok) {
        console.log('✅ Photo sent successfully!');
      } else {
        console.log('❌ Failed to send photo:', response.description);
      }
    });
  });
  
  req.on('error', (error) => {
    console.error('Error:', error);
  });
  
  // Write all parts to the request
  parts.forEach(part => {
    req.write(part);
  });
  
  req.end();
}

console.log('Sending photo to chat ID:', CHAT_ID);
sendPhoto();

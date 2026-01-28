// Simulate the bug in parseSearchResults
const html = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Frepo">GitHub Repo</a>
  <a class="result__snippet">A great repository</a>
</div>
`;

const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const match = linkRegex.exec(html);

if (match) {
  const url = decodeURIComponent(match[1]); // BUG: Decodes BEFORE checking!
  const title = match[2].trim();
  console.log('Decoded URL:', url);
  console.log('Includes duckduckgo.com:', url.includes('duckduckgo.com'));
  console.log('Will this be filtered out?', url.includes('duckduckgo.com') ? 'YES - BUG!' : 'No');
}

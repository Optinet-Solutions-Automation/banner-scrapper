/**
 * One-time script to get a Google OAuth2 refresh token for Drive uploads.
 *
 * SETUP (do this once in Google Cloud Console — banner-scraper-api project):
 *   1. Go to: APIs & Services → Credentials → + Create Credentials → OAuth 2.0 Client ID
 *   2. Application type: Web application
 *   3. Name: BannerBot Local
 *   4. Authorized redirect URIs: http://localhost:3002
 *   5. Click Create → copy Client ID and Client Secret
 *
 * USAGE:
 *   OAUTH_CLIENT_ID=xxx OAUTH_CLIENT_SECRET=yyy node scripts/get-drive-token.js
 *
 * Then paste the printed GOOGLE_OAUTH2_REFRESH_TOKEN value into your .env file.
 */

const http    = require('http');
const { google } = require('googleapis');

const CLIENT_ID     = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3002';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: OAUTH_CLIENT_ID=xxx OAUTH_CLIENT_SECRET=yyy node scripts/get-drive-token.js');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\n──────────────────────────────────────────────────────');
console.log('1. Open this URL in your browser:');
console.log('\n' + authUrl + '\n');
console.log('2. Sign in with your Google account and click Allow.');
console.log('3. You will be redirected to localhost — this script will');
console.log('   capture the code automatically and print your token.');
console.log('──────────────────────────────────────────────────────\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400); res.end('Missing code');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>Success! You can close this tab and check your terminal.</h2>');
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n✅ TOKEN OBTAINED — add these to your .env:\n');
    console.log(`GOOGLE_OAUTH2_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_OAUTH2_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_OAUTH2_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nDone! Drive uploads will now use your personal quota.\n');
  } catch (err) {
    console.error('Failed to exchange code:', err.message);
    process.exit(1);
  }
});

server.listen(3002, () => {
  console.log('Waiting for Google auth callback on http://localhost:3002 ...');
});

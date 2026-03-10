/**
 * whatsapp-notifier.ts — Sends a WhatsApp message via Meta Business Cloud API.
 *
 * Required env vars:
 *   WHATSAPP_PHONE_NUMBER_ID  — from Meta Developer Console (e.g. 123456789012345)
 *   WHATSAPP_ACCESS_TOKEN     — permanent system user token or temp test token
 *   WHATSAPP_RECIPIENT        — recipient phone number in E.164 format (e.g. +63912345678)
 */
import * as https from 'https';

export async function sendWhatsAppNotification(
  domain: string,
  tier: number,
  geo: string,
  bannerCount: number,
  driveFolderUrl: string | null
): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;
  const recipient     = process.env.WHATSAPP_RECIPIENT;

  if (!phoneNumberId || !token || !recipient) return;  // not configured

  const lines = [
    `🤖 *BannerBot*`,
    ``,
    `${bannerCount > 0 ? '✅' : '⚠️'} *${domain}*`,
    `🎯 Tier ${tier}${geo ? ' · ' + geo.toUpperCase() : ''}`,
    `🖼 ${bannerCount} banner${bannerCount !== 1 ? 's' : ''} scraped`,
  ];

  if (driveFolderUrl) {
    lines.push(``, `📁 *Drive folder:*`, driveFolderUrl);
  } else if (bannerCount > 0) {
    lines.push(``, `⚠️ Drive upload not configured`);
  }

  const text = lines.join('\n');

  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to:   recipient.replace(/\D/g, ''),   // strip non-digits for safety
    type: 'text',
    text: { body: text },
  });

  await new Promise<void>((resolve) => {
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path:     `/v19.0/${phoneNumberId}/messages`,
        method:   'POST',
        headers:  {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`  📱 WhatsApp sent to ${recipient}`);
          } else {
            console.warn(`  ⚠ WhatsApp API error ${res.statusCode}: ${body.substring(0, 200)}`);
          }
          resolve();
        });
      }
    );
    req.on('error', (e) => { console.warn(`  ⚠ WhatsApp error: ${e.message}`); resolve(); });
    req.write(payload);
    req.end();
  });
}

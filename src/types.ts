export enum FailureReason {
  CLOUDFLARE_CHALLENGE = 'cloudflare_challenge',
  CAPTCHA_DETECTED = 'captcha_detected',
  GEO_BLOCKED = 'geo_blocked',
  ACCESS_DENIED = 'access_denied',
  TIMEOUT = 'timeout',
  EMPTY_PAGE = 'empty_page',
  BOT_DETECTED = 'bot_detected',
  HARD_BLOCKED = 'hard_blocked',       // completely blank response — no title/body/images
  CONNECTION_REFUSED = 'connection_refused',
  CONTENT_MISSING = 'content_missing',
}

export interface TierResult {
  success: boolean;
  failureReason?: FailureReason;
  screenshotPath?: string;
  statusCode?: number;
  tier: number;
}

export interface BannerImage {
  src: string;
  localPath?: string;
  gcsUrl?: string;   // public GCS URL after upload (accessible from anywhere)
  width: number;
  height: number;
  aspectRatio: number;
  altText?: string;
  context: string;  // e.g. "hero", "carousel", "promo-card"
  page: 'homepage' | 'promotions';
  score: number;
}

export interface ScrapeResult {
  url: string;
  domain: string;
  tier: number;
  geo?: string;            // geo used for datacenter/residential proxy (e.g. "ca", "gb")
  homepageBanners: BannerImage[];
  promoBanners: BannerImage[];
  success: boolean;
  error?: string;
  scrapedAt: string;
}

export interface SiteMemoryEntry {
  lastSuccessfulTier: number;
  lastScraped: string;
  workingGeo?: string;     // last working geo for datacenter proxy
}

export type SiteMemory = Record<string, SiteMemoryEntry>;

export interface TierConfig {
  tier: number;
  name: string;
  stealth: boolean;
  proxy: 'none' | 'datacenter' | 'residential';
  userAgentRotation: boolean;
  humanDelays: boolean;
  geoTargeting: boolean;
  timeout: number;
  retries: number;
  waitUntil: 'networkidle' | 'load' | 'domcontentloaded';
}

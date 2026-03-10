import { Page } from 'playwright';
import { BannerImage } from './types';
import { config } from './config';

// Keywords that BOOST confidence an image is a banner
const BANNER_BOOST_CLASSES = [
  'banner', 'hero', 'slider', 'carousel', 'promo', 'promotion',
  'featured', 'spotlight', 'swiper', 'slick', 'owl', 'campaign',
];

// Keywords that EXCLUDE an image from being a banner
const EXCLUSION_KEYWORDS = [
  'logo', 'icon', 'avatar', 'thumbnail', 'game-tile', 'game_tile',
  'provider', 'badge', 'button', 'footer', 'header-logo', 'payment',
  'certification', 'flag', 'currency', 'nav', 'menu', 'sprite',
  'paymethod', 'social', 'brand', 'partner', 'software',
];

function calcScore(img: {
  width: number; height: number; src: string;
  className: string; id: string; alt: string;
  containerClass: string; hasLazy: boolean;
}): number {
  let score = 0;
  // Exclusion check: only use the image's OWN attributes (src, class, id, alt).
  // Do NOT include containerClass — it can be the site body/wrapper class which
  // may contain short words like "nav", "menu" in compound names (e.g. "main-nav-re-design")
  // causing legitimate banners to be falsely excluded.
  const imgCtx = `${img.src} ${img.className} ${img.id} ${img.alt}`.toLowerCase();

  // Hard exclusions → negative score
  for (const kw of EXCLUSION_KEYWORDS) {
    if (imgCtx.includes(kw)) return -999;
  }

  // SVG hard-exclusion: casino promotional banners are always photographic
  // (JPEG/WebP/PNG/AVIF). SVGs are decorative illustrations, icons, logos.
  const srcPath = img.src.toLowerCase().split('?')[0]; // strip query params for extension check
  if (srcPath.endsWith('.svg') || srcPath.endsWith('.gif')) return -999;

  // Size bonus
  score += Math.min(img.width / 100, 10);
  score += Math.min(img.height / 50, 6);

  // Aspect ratio 1.5–5 is ideal for banners
  const ar = img.width / img.height;
  if (ar >= 1.5 && ar <= 5) score += 5;
  else if (ar < 0.7) return -999;  // portrait orientation — never a banner (page bg, sprite sheets, etc.)
  else if (ar < 1.3) score -= 5;  // too square to be a promotional banner

  // Banner class/id hints
  const ctxStr = `${img.className} ${img.id} ${img.containerClass}`.toLowerCase();
  for (const kw of BANNER_BOOST_CLASSES) {
    if (ctxStr.includes(kw)) { score += 4; break; }
  }

  // Promotional alt text
  if (/bonus|promo|offer|reward|free|welcome|deposit/i.test(img.alt)) score += 3;

  // Lazy-loaded images are often important banners
  if (img.hasLazy) score += 2;

  return score;
}

export async function detectBanners(
  page: Page,
  pageType: 'homepage' | 'promotions'
): Promise<BannerImage[]> {
  // Promotions pages use lower floors so individual promo-card images
  // (which sit inside a 2–3 column grid and render ~300-450px wide × 90-150px tall)
  // are captured. Cards are CSS-scaled down but their natural image dimensions are
  // banner-sized — the natural-dim fallback below picks them up.
  const minBannerWidth = pageType === 'promotions'
    ? Math.round(config.minBannerWidth * 0.6)   // 500 → 300px
    : config.minBannerWidth;
  const minBannerHeight = pageType === 'promotions'
    ? Math.round(config.minBannerHeight * 0.6)   // 150 → 90px
    : config.minBannerHeight;

  const rawImages = await page.evaluate(
    ({ minW, minH }) => {
      const results: Array<{
        src: string; width: number; height: number;
        naturalWidth: number; naturalHeight: number;
        alt: string; className: string; id: string;
        containerClass: string; hasLazy: boolean;
      }> = [];

      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const rect = img.getBoundingClientRect();
        let w = Math.round(rect.width);
        let h = Math.round(rect.height);

        // Two cases where we fall back to natural dimensions:
        //
        // 1. Collapsed carousel slides (h < 5 or w < 5): inactive Swiper slides are
        //    set to height:1px by the carousel CSS. Natural dims give the real size.
        //
        // 2. Promo-card images rendered small in a grid: the actual artwork is
        //    banner-sized (e.g. 640×213px) but CSS scales it down to fit the card
        //    (e.g. 450×107px rendered). Rendered height falls under the threshold
        //    even though the image IS a promotional banner.
        //    Use natural dims whenever the rendered size fails the threshold but the
        //    natural image is clearly large enough to be a real banner.
        if ((w < minW || h < minH) && img.naturalWidth >= minW && img.naturalHeight >= minH) {
          w = img.naturalWidth;
          h = img.naturalHeight;
        }

        if (w < minW || h < minH) continue;

        // Resolve the best available src URL:
        // - If src attribute is non-empty, use browser-resolved img.src (absolute).
        // - If src="" or missing (srcset-only images like NetBet), use currentSrc
        //   which the browser already selected from srcset based on viewport/DPR.
        // - Fall back to data-* lazy-load attributes as last resort.
        const srcAttr = img.getAttribute('src') ?? '';
        let src: string;
        if (srcAttr && !srcAttr.startsWith('data:')) {
          src = img.src; // browser-resolved absolute URL from src attribute
        } else {
          src = img.currentSrc || ''; // browser's choice from srcset
        }
        if (!src || src.startsWith('data:')) {
          const lazy =
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy') ||
            img.getAttribute('data-original') || '';
          if (!lazy || lazy.startsWith('data:')) {
            // Last resort: parse srcset for first real URL.
            // Handles Next.js <Image> not yet hydrated — currentSrc is data: blur placeholder
            // but the real image URL is in srcset.
            const srcsetAttr = img.getAttribute('srcset') ?? img.getAttribute('data-srcset') ?? '';
            const firstSrc = srcsetAttr.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
            if (!firstSrc || firstSrc.startsWith('data:')) continue;
            try { src = new URL(firstSrc, document.baseURI).href; } catch { continue; }
          } else {
            try { src = new URL(lazy, document.baseURI).href; } catch { continue; }
          }
        }

        const container = img.closest(
          '[class*="banner"],[class*="hero"],[class*="slider"],[class*="carousel"],' +
          '[class*="promo"],[class*="swiper"],[class*="slick"],[class*="owl"],section,header'
        );

        results.push({
          src,
          width:  w,
          height: h,
          naturalWidth:  img.naturalWidth,
          naturalHeight: img.naturalHeight,
          alt:           img.getAttribute('alt') ?? '',
          className:     img.className ?? '',
          id:            img.id ?? '',
          containerClass: container ? (container as HTMLElement).className : '',
          hasLazy: img.hasAttribute('loading') || img.hasAttribute('data-src') ||
                   img.hasAttribute('data-lazy'),
        });
      }
      return results;
    },
    { minW: minBannerWidth, minH: minBannerHeight }
  );

  // Grab <video poster="..."> — hero banners on casino sites often use autoplay video
  const videoPosters = await page.evaluate(
    ({ minW, minH }) => {
      const out: Array<{
        src: string; width: number; height: number;
        containerClass: string; hasLazy: boolean;
      }> = [];
      for (const vid of Array.from(document.querySelectorAll('video[poster]'))) {
        const rect = vid.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w < minW || h < minH) continue;
        const raw = (vid as HTMLVideoElement).getAttribute('poster') ?? '';
        if (!raw || raw.startsWith('data:')) continue;
        let src = raw;
        try { src = new URL(raw, document.baseURI).href; } catch { /* keep */ }
        const container = vid.closest(
          '[class*="banner"],[class*="hero"],[class*="slider"],[class*="carousel"],' +
          '[class*="promo"],[class*="swiper"],section,header'
        );
        out.push({ src, width: w, height: h, containerClass: container ? (container as HTMLElement).className : 'video-hero', hasLazy: false });
      }
      return out;
    },
    { minW: minBannerWidth, minH: minBannerHeight }
  );

  // Also grab CSS background-images from prominent containers.
  // Two passes:
  //   1. Targeted: elements with banner-related class names (fast, high precision)
  //   2. Broad: large visible elements anywhere on page (catches sites like Unibet
  //      whose hero uses custom class names with no standard banner keywords)
  const bgImages = await page.evaluate(
    ({ minW, minH }) => {
      const out: Array<{ src: string; width: number; height: number; containerClass: string }> = [];
      const seenBg = new Set<string>();

      const SKIP_TAGS = new Set(['nav','footer','button','a','span','li','ul','ol','input','select','textarea','script','style','head']);
      const SKIP_CLASS_KW = ['footer', 'navigation', 'logo', 'icon', 'payment', 'sponsor', 'cookie', 'modal', 'popup'];

      function tryAdd(el: Element) {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return;
        // SVG elements have className as SVGAnimatedString — use baseVal or fall back to ''
        const rawCls = (el instanceof HTMLElement) ? (el.className ?? '') : '';
        const cls = (typeof rawCls === 'string' ? rawCls : '').toLowerCase();
        if (SKIP_CLASS_KW.some(kw => cls.includes(kw))) return;

        const bg = window.getComputedStyle(el).backgroundImage;
        const match = bg.match(/url\(["']?(.+?)["']?\)/);
        if (!match?.[1] || match[1].startsWith('data:')) return;
        if (seenBg.has(match[1])) return;
        seenBg.add(match[1]);

        const rect = el.getBoundingClientRect();
        if (rect.width < minW || rect.height < minH) return;

        let bgSrc = match[1];
        try { bgSrc = new URL(bgSrc, document.baseURI).href; } catch { /* keep as-is */ }
        const elCls = (el instanceof HTMLElement) ? (el.className ?? '') : '';
        out.push({ src: bgSrc, width: Math.round(rect.width), height: Math.round(rect.height), containerClass: typeof elCls === 'string' ? elCls : '' });
      }

      // Pass 1: targeted banner-class elements
      // [class*="slide"] catches carousel slide items (e.g. "g-slide", "slide-item",
      // "keen-slide") whose siblings are ALL in the DOM simultaneously, so we can
      // scrape every slide's background in one pass without waiting for auto-rotation.
      const targeted = Array.from(document.querySelectorAll(
        '[class*="banner"],[class*="hero"],[class*="slider"],[class*="carousel"],' +
        '[class*="promo"],[class*="swiper"],[class*="slick"],[class*="spotlight"],' +
        '[class*="feature"],[class*="offer"],[class*="welcome"],[class*="billboard"],' +
        '[class*="slide"]'
      ));
      for (const el of targeted) tryAdd(el);

      // Pass 2: point-based detection — find whatever element is visually AT the
      // hero banner position (top 20–50% of viewport). Catches deeply-nested elements
      // with custom class names (e.g. Unibet's homepage hero).
      if (out.length === 0) {
        const cx = Math.round(window.innerWidth / 2);
        for (const yFrac of [0.2, 0.3, 0.4, 0.5]) {
          const cy = Math.round(window.innerHeight * yFrac);
          const stack = document.elementsFromPoint(cx, cy);
          for (const el of stack) tryAdd(el);
          if (out.length > 0) break;
        }
      }

      // Pass 3: walk direct children of body / main up to 3 levels deep
      if (out.length === 0) {
        function walkDeep(el: Element, depth: number) {
          if (depth < 0 || out.length >= 10) return;
          tryAdd(el);
          for (const child of Array.from(el.children).slice(0, 10)) walkDeep(child, depth - 1);
        }
        const root = document.querySelector('main') ?? document.body;
        for (const child of Array.from(root.children).slice(0, 10)) walkDeep(child, 2);
      }

      return out.slice(0, 10);
    },
    { minW: minBannerWidth, minH: minBannerHeight }
  );

  const seen = new Set<string>();
  const banners: BannerImage[] = [];

  const process = (item: {
    src: string; width: number; height: number; alt?: string;
    className?: string; id?: string; containerClass?: string; hasLazy?: boolean;
  }, contextLabel: string) => {
    if (seen.has(item.src)) return;
    seen.add(item.src);

    const score = calcScore({
      width:          item.width,
      height:         item.height,
      src:            item.src,
      className:      item.className ?? '',
      id:             item.id ?? '',
      alt:            item.alt ?? '',
      containerClass: item.containerClass ?? '',
      hasLazy:        item.hasLazy ?? false,
    });

    // Minimum score threshold: filters out borderline images like game thumbnails
    // rendered at banner sizes (e.g. leovegas 1080×1080 squares at score≈11).
    // Promotions pages use a lower threshold (10) because promo cards in a 2-column
    // grid render at ~350-400px — just below the 14 threshold without a class boost.
    const minScore = pageType === 'promotions' ? 12 : 14;
    if (score < minScore) return;

    banners.push({
      src:         item.src,
      width:       item.width,
      height:      item.height,
      aspectRatio: +(item.width / item.height).toFixed(2),
      altText:     item.alt,
      context:     contextLabel,
      page:        pageType,
      score,
    });
  };

  for (const img of rawImages)    process(img, img.containerClass || 'img');
  for (const vid of videoPosters) process({ ...vid, alt: '', id: '', className: '' }, 'video-poster');
  for (const bg of bgImages)      process({ ...bg, alt: '' }, 'css-background');

  return banners
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);  // top-30 candidates — promo pages can have 15-20+ individual cards
}

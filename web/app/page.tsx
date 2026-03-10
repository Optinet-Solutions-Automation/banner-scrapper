'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// ── Config ─────────────────────────────────────────────────────────────────────
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

const GEO_OPTIONS = [
  { value: '',   label: 'Auto-detect',    flag: '🌍' },
  { value: 'ph', label: 'Philippines',    flag: '🇵🇭' },
  { value: 'ca', label: 'Canada',         flag: '🇨🇦' },
  { value: 'gb', label: 'United Kingdom', flag: '🇬🇧' },
  { value: 'au', label: 'Australia',      flag: '🇦🇺' },
  { value: 'se', label: 'Sweden',         flag: '🇸🇪' },
  { value: 'in', label: 'India',          flag: '🇮🇳' },
  { value: 'us', label: 'United States',  flag: '🇺🇸' },
  { value: 'de', label: 'Germany',        flag: '🇩🇪' },
  { value: 'nz', label: 'New Zealand',    flag: '🇳🇿' },
  { value: 'sg', label: 'Singapore',      flag: '🇸🇬' },
];

const GEO_FLAGS: Record<string, string> = {
  ph: '🇵🇭', ca: '🇨🇦', gb: '🇬🇧', au: '🇦🇺', se: '🇸🇪',
  in: '🇮🇳', us: '🇺🇸', de: '🇩🇪', nz: '🇳🇿', sg: '🇸🇬', fr: '🇫🇷',
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface BannerImage {
  src: string;
  localPath?: string;
  gcsUrl?: string;
  width: number;
  height: number;
  aspectRatio: number;
  altText?: string;
  context: string;
  page: 'homepage' | 'promotions';
  score: number;
}

interface ScrapeResult {
  url: string;
  domain: string;
  tier: number;
  geo?: string;
  homepageBanners: BannerImage[];
  promoBanners: BannerImage[];
  success: boolean;
  error?: string;
  scrapedAt: string;
  driveFolderId?: string;
  driveFolderUrl?: string;
}

interface ProgressEvent {
  type: string;
  domain?: string;
  url?: string;
  message?: string;
  tier?: number;
  reason?: string;
  geo?: string;
  result?: ScrapeResult;
  results?: ScrapeResult[];
  total?: number;
}

interface SiteMemoryEntry {
  lastSuccessfulTier: number;
  lastScraped: string;
  workingGeo?: string;
}

type SiteMemory = Record<string, SiteMemoryEntry>;

interface SiteStatus {
  domain: string;
  url: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  currentTier?: number;
  currentGeo?: string;
  message?: string;
  result?: ScrapeResult;
}

interface PromptItem {
  imageUrl?: string;
  bannerSrc?: string;
  prompt: string;
  page?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function bannerImageUrl(domain: string, localPath?: string): string {
  if (!localPath) return '';
  const filename = localPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return `${BACKEND}/banners/${domain}/${filename}`;
}

function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

const TIER_META: Record<number, { label: string; color: string; dot: string }> = {
  1: { label: 'T1 Vanilla', color: 'text-emerald-400',  dot: 'bg-emerald-400' },
  2: { label: 'T2 Stealth', color: 'text-sky-400',      dot: 'bg-sky-400' },
  3: { label: 'T3 Proxy',   color: 'text-amber-400',    dot: 'bg-amber-400' },
  4: { label: 'T4 Resi',    color: 'text-fuchsia-400',  dot: 'bg-fuchsia-400' },
};

function TierBadge({ tier }: { tier: number }) {
  const meta = TIER_META[tier];
  if (!meta) return <span className="text-xs text-slate-500">T{tier}</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${meta.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function logLineColor(type: string): string {
  switch (type) {
    case 'site_start': return 'text-amber-400';
    case 'tier':       return 'text-slate-300';
    case 'geo_try':    return 'text-sky-400';
    case 'tier_fail':  return 'text-red-400';
    case 'site_done':  return 'text-emerald-400';
    case 'done':       return 'text-emerald-300';
    case 'error':      return 'text-red-400';
    case 'progress':   return 'text-slate-600';
    default:           return 'text-slate-500';
  }
}

function logLinePrefix(type: string): string {
  switch (type) {
    case 'site_start': return '▶';
    case 'tier':       return '○';
    case 'geo_try':    return '↺';
    case 'tier_fail':  return '✗';
    case 'site_done':  return '●';
    case 'done':       return '✓';
    case 'error':      return '!';
    case 'progress':   return '·';
    default:           return '·';
  }
}

function formatLogEvent(ev: ProgressEvent): string {
  if (ev.message) return ev.message;
  switch (ev.type) {
    case 'start':      return `Starting batch · ${ev.total} site${(ev.total ?? 0) > 1 ? 's' : ''}`;
    case 'site_start': return `[${ev.domain}] Starting scrape`;
    case 'tier':       return `[${ev.domain}] Tier ${ev.tier}`;
    case 'geo_try':    return `[${ev.domain}] Trying geo ${(ev.geo ?? '').toUpperCase()}`;
    case 'tier_fail':  return `[${ev.domain}] Tier ${ev.tier}${ev.geo ? ` (${ev.geo.toUpperCase()})` : ''} — ${ev.reason ?? 'failed'}`;
    case 'site_done':
      if (ev.result?.success)
        return `[${ev.domain}] ✓ T${ev.result.tier}${ev.result.geo ? ` ${ev.result.geo.toUpperCase()}` : ''} · ${ev.result.homepageBanners.length}hp ${ev.result.promoBanners.length}pr`;
      return `[${ev.domain}] ✗ ${ev.result?.error ?? 'all tiers exhausted'}`;
    case 'done': return `Batch complete · ${ev.results?.length ?? 0} processed`;
    default:     return ev.message ?? ev.type;
  }
}

// ── SVG Logo ──────────────────────────────────────────────────────────────────
function LogoIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polygon
        points="18,3 31,9.5 31,26.5 18,33 5,26.5 5,9.5"
        stroke="#f59e0b"
        strokeWidth="1.5"
        fill="rgba(245,158,11,0.06)"
      />
      <line x1="10" y1="14" x2="26" y2="14" stroke="#f59e0b" strokeWidth="1" opacity="0.4" />
      <line x1="9"  y1="18" x2="27" y2="18" stroke="#f59e0b" strokeWidth="1.8" />
      <line x1="10" y1="22" x2="26" y2="22" stroke="#f59e0b" strokeWidth="1" opacity="0.4" />
      <circle cx="18" cy="18" r="2.5" fill="#f59e0b" opacity="0.9" />
    </svg>
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function BackendStatus({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 status-dot-online' : 'bg-red-500'}`}
      />
      <span className={`text-xs font-medium ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
        {connected ? 'Connected' : 'Offline'}
      </span>
    </div>
  );
}

function SiteStatusCard({ site }: { site: SiteStatus }) {
  const stateColors = {
    pending: 'bg-slate-700',
    running: 'bg-amber-400',
    done:    'bg-emerald-400',
    failed:  'bg-red-500',
  };

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-surface-2 border border-border hover:border-border-2 transition-colors">
      {/* Status bar */}
      <span className={`w-0.5 h-8 rounded-full flex-shrink-0 ${stateColors[site.state]} ${site.state === 'running' ? 'pulse-amber' : ''}`} />

      {/* Domain */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-100 truncate">{site.domain}</div>
        {site.state === 'running' && (
          <div className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
            <span className="spin text-amber-400 text-[10px]">⟳</span>
            {site.currentTier !== undefined && `Tier ${site.currentTier}`}
            {site.currentGeo && ` · ${(GEO_FLAGS[site.currentGeo] ?? '')} ${site.currentGeo.toUpperCase()}`}
          </div>
        )}
        {site.state === 'pending' && <div className="text-[11px] text-slate-600 mt-0.5">Waiting…</div>}
      </div>

      {/* Result meta */}
      {site.result && (
        <div className="flex-shrink-0 text-right">
          <TierBadge tier={site.result.tier} />
          {site.result.geo && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              {GEO_FLAGS[site.result.geo] ?? site.result.geo.toUpperCase()}&nbsp;
              {site.result.homepageBanners.length + site.result.promoBanners.length} banners
            </div>
          )}
        </div>
      )}
      {site.state === 'failed' && !site.result && (
        <span className="text-[11px] text-red-400 max-w-[120px] truncate text-right flex-shrink-0">
          {site.message ?? 'Failed'}
        </span>
      )}
    </div>
  );
}

function LightboxModal({
  banner, domain, onClose,
}: { banner: BannerImage; domain: string; onClose: () => void }) {
  const imgUrl = banner.gcsUrl || bannerImageUrl(domain, banner.localPath);
  const displayUrl = imgUrl || banner.src;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="card overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-surface-2 border-b border-border">
            <div className="flex items-center gap-3 min-w-0">
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                banner.page === 'promotions'
                  ? 'bg-fuchsia-900/80 text-fuchsia-200 border border-fuchsia-700/50'
                  : 'bg-sky-900/80 text-sky-200 border border-sky-700/50'
              }`}>{banner.page === 'promotions' ? 'PROMO' : 'HOME'}</span>
              <span className="text-xs text-slate-400 font-mono truncate">
                {banner.width}×{banner.height} · score {banner.score.toFixed(0)} · AR {banner.aspectRatio}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-3">
              <a
                href={displayUrl}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-accent hover:text-accent-light border border-border hover:border-border-2 px-2.5 py-1 rounded-lg transition-colors"
                onClick={e => e.stopPropagation()}
              >
                ↓ Download
              </a>
              <a
                href={banner.src}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-slate-400 hover:text-slate-200 border border-border hover:border-border-2 px-2.5 py-1 rounded-lg transition-colors"
                onClick={e => e.stopPropagation()}
              >
                ↗ Source
              </a>
              <button
                onClick={onClose}
                className="text-slate-400 hover:text-slate-100 text-xl w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-3 transition-colors"
              >
                ×
              </button>
            </div>
          </div>
          {/* Image */}
          <div className="bg-surface/80 flex items-center justify-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={displayUrl}
              alt={banner.altText ?? `Banner ${banner.width}×${banner.height}`}
              className="max-w-full max-h-[70vh] object-contain rounded-lg"
            />
          </div>
          {/* Footer */}
          {banner.altText && (
            <div className="px-4 py-2 bg-surface-2 border-t border-border text-[11px] text-slate-500 truncate">
              alt: &quot;{banner.altText}&quot;
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BannerCard({
  banner, domain, onOpenLightbox,
}: { banner: BannerImage; domain: string; onOpenLightbox: () => void }) {
  const imgUrl = banner.gcsUrl || bannerImageUrl(domain, banner.localPath);
  const [loaded, setLoaded] = useState(false);
  const [error, setError]   = useState(false);

  return (
    <div className="group relative rounded-lg overflow-hidden border border-border hover:border-accent transition-all duration-200 bg-surface-2 cursor-pointer">
      {/* Page badge */}
      <span className={`absolute top-2 left-2 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded-md backdrop-blur-sm ${
        banner.page === 'promotions'
          ? 'bg-fuchsia-900/80 text-fuchsia-200 border border-fuchsia-700/50'
          : 'bg-sky-900/80 text-sky-200 border border-sky-700/50'
      }`}>
        {banner.page === 'promotions' ? 'PROMO' : 'HOME'}
      </span>

      {/* Image — click opens lightbox */}
      <button className="block w-full text-left" onClick={onOpenLightbox}>
        {!error ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgUrl || banner.src}
              alt={banner.altText ?? `Banner ${banner.width}×${banner.height}`}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
              className={`w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
              style={{ aspectRatio: `${Math.min(banner.aspectRatio, 4)} / 1` }}
            />
            {!loaded && <div className="shimmer w-full" style={{ aspectRatio: '3/1' }} />}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-1 py-6 text-slate-600">
            <span className="text-lg">⊘</span>
            <span className="text-[11px]">Image unavailable</span>
          </div>
        )}
      </button>

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none flex items-end p-2">
        <span className="text-[11px] text-white/80">{banner.width}×{banner.height} · click to expand</span>
      </div>

      {/* Bottom meta */}
      <div className="px-2.5 py-1.5 flex items-center justify-between text-[10px] text-slate-600 border-t border-border">
        <span>{banner.width}×{banner.height}</span>
        <span>score {banner.score.toFixed(0)}</span>
      </div>
    </div>
  );
}

function PromptsPanel({
  domain,
  prompts,
  approvalState,
  onApprove,
}: {
  domain: string;
  prompts: PromptItem[];
  approvalState: Record<string, 'approved' | 'rejected'>;
  onApprove: (domain: string, item: PromptItem, idx: number, approved: boolean) => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);

  const copyPrompt = (text: string, idx: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(idx);
      setTimeout(() => setCopied(null), 1800);
    });
  };

  return (
    <div className="border-t border-border bg-[#040810]/60 p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="section-label text-[10px]">AI Prompts</span>
        <span className="text-[11px] text-slate-600">{prompts.length} generated</span>
      </div>

      {prompts.map((item, i) => {
        const key = `${domain}::${i}`;
        const status = approvalState[key];
        const displayUrl = item.imageUrl || item.bannerSrc;

        return (
          <div
            key={i}
            className={`rounded-xl border p-4 space-y-3 transition-colors ${
              status === 'approved'
                ? 'border-emerald-700/60 bg-emerald-950/20'
                : status === 'rejected'
                ? 'border-red-900/40 bg-red-950/10 opacity-60'
                : 'border-border bg-surface-2'
            }`}
          >
            {/* Mini banner thumbnail */}
            {displayUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={displayUrl}
                alt=""
                className="w-full max-h-20 object-cover rounded-lg opacity-75"
              />
            )}

            {/* Prompt text */}
            <p className="text-[12px] text-slate-300 font-mono leading-relaxed whitespace-pre-wrap">
              {item.prompt}
            </p>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => onApprove(domain, item, i, true)}
                className={`text-[11px] px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                  status === 'approved'
                    ? 'bg-emerald-900/60 border-emerald-700 text-emerald-300'
                    : 'border-border hover:border-emerald-700/70 hover:text-emerald-400 text-slate-400'
                }`}
              >
                {status === 'approved' ? '✓ Approved' : 'Approve'}
              </button>
              <button
                onClick={() => onApprove(domain, item, i, false)}
                className={`text-[11px] px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                  status === 'rejected'
                    ? 'bg-red-900/60 border-red-700 text-red-300'
                    : 'border-border hover:border-red-800/70 hover:text-red-400 text-slate-400'
                }`}
              >
                {status === 'rejected' ? '✗ Rejected' : 'Not Approved'}
              </button>
              <button
                onClick={() => copyPrompt(item.prompt, i)}
                className="ml-auto text-[11px] text-slate-600 hover:text-slate-300 border border-border hover:border-border-2 px-2.5 py-1.5 rounded-lg transition-colors"
              >
                {copied === i ? '✓ Copied' : '⎘ Copy'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ResultCard({
  result, onRerun, onOpenLightbox, canRerun,
  prompts, approvalState, onApprove, promptsLoading,
}: {
  result: ScrapeResult;
  onRerun: (url: string) => void;
  onOpenLightbox: (banner: BannerImage, domain: string) => void;
  canRerun: boolean;
  prompts: PromptItem[] | null;
  approvalState: Record<string, 'approved' | 'rejected'>;
  onApprove: (domain: string, item: PromptItem, idx: number, approved: boolean) => void;
  promptsLoading: boolean;
}) {
  const allBanners = [...result.homepageBanners, ...result.promoBanners];
  return (
    <div className={`card overflow-hidden ${result.success ? '' : 'border-red-900/50'}`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-5 py-3.5 ${result.success ? 'bg-surface-2' : 'bg-red-950/20'}`}>
        <span className={`text-lg font-bold ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
          {result.success ? '✓' : '✗'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-100 tracking-tight">{result.domain}</div>
          <div className="text-[11px] text-slate-500 font-mono truncate">{result.url}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {result.success && <TierBadge tier={result.tier} />}
          {result.geo && (
            <span className="text-sm" title={result.geo.toUpperCase()}>
              {GEO_FLAGS[result.geo] ?? result.geo.toUpperCase()}
            </span>
          )}
          {result.success && allBanners.length > 0 && (
            <span className="text-xs text-slate-400 bg-surface-3 px-2 py-0.5 rounded-full border border-border">
              {allBanners.length} banner{allBanners.length !== 1 ? 's' : ''}
            </span>
          )}
          {/* Drive folder link */}
          {result.driveFolderUrl && (
            <a
              href={result.driveFolderUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open Drive folder"
              className="text-[11px] text-slate-500 hover:text-emerald-400 border border-border hover:border-emerald-800/60 px-2.5 py-1 rounded-lg transition-colors"
            >
              ☁ Drive
            </a>
          )}
          {/* Prompts loading indicator */}
          {promptsLoading && (
            <span className="text-[11px] text-accent flex items-center gap-1">
              <span className="spin text-[10px]">⟳</span> Analyzing…
            </span>
          )}
          {/* Rerun button */}
          <button
            onClick={() => onRerun(result.url)}
            disabled={!canRerun}
            title="Re-scrape this site"
            className="text-[11px] text-slate-400 hover:text-amber-400 border border-border hover:border-amber-800/60 px-2.5 py-1 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↺ Rerun
          </button>
        </div>
      </div>

      {/* Banners grid */}
      {allBanners.length > 0 ? (
        <div className="p-3 bg-surface/50 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {allBanners.map((b, i) => (
            <BannerCard
              key={`${b.src}-${i}`}
              banner={b}
              domain={result.domain}
              onOpenLightbox={() => onOpenLightbox(b, result.domain)}
            />
          ))}
        </div>
      ) : result.success ? (
        <div className="px-5 py-4 text-slate-600 text-sm">No banners detected on this site.</div>
      ) : (
        <div className="px-5 py-4 text-red-400/80 text-sm leading-relaxed">{result.error}</div>
      )}

      {/* Prompts panel */}
      {prompts && prompts.length > 0 && (
        <PromptsPanel
          domain={result.domain}
          prompts={prompts}
          approvalState={approvalState}
          onApprove={onApprove}
        />
      )}
      {prompts && prompts.length === 0 && (
        <div className="border-t border-border px-5 py-4 text-slate-600 text-xs">
          n8n returned no prompts. Check your workflow configuration.
        </div>
      )}
    </div>
  );
}

function SiteMemoryTable({ memory, onUpdate }: { memory: SiteMemory; onUpdate: () => void }) {
  const [filter, setFilter] = useState('');

  const entries = useMemo(() => {
    const all = Object.entries(memory).sort(
      (a, b) => new Date(b[1].lastScraped).getTime() - new Date(a[1].lastScraped).getTime()
    );
    if (!filter) return all;
    const q = filter.toLowerCase();
    return all.filter(([domain]) => domain.toLowerCase().includes(q));
  }, [memory, filter]);

  const handleGeoChange = async (domain: string, geo: string) => {
    await fetch(`${BACKEND}/sites/${encodeURIComponent(domain)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingGeo: geo || undefined }),
    });
    onUpdate();
  };

  const handleDelete = async (domain: string) => {
    await fetch(`${BACKEND}/sites/${encodeURIComponent(domain)}`, { method: 'DELETE' });
    onUpdate();
  };

  if (Object.keys(memory).length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-slate-600">
        <span className="text-2xl opacity-30">◫</span>
        <span className="text-sm">No sites scraped yet</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search filter */}
      <input
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter by domain…"
        className="w-full sm:w-64 bg-surface-3 border border-border hover:border-border-2 focus:border-accent rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none transition-colors"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b border-border">
              <th className="pb-3 pr-6 text-[11px] font-semibold tracking-widest uppercase text-slate-600">Domain</th>
              <th className="pb-3 pr-6 text-[11px] font-semibold tracking-widest uppercase text-slate-600">Tier</th>
              <th className="pb-3 pr-6 text-[11px] font-semibold tracking-widest uppercase text-slate-600">Geo</th>
              <th className="pb-3 pr-6 text-[11px] font-semibold tracking-widest uppercase text-slate-600">Last Scraped</th>
              <th className="pb-3 text-[11px] font-semibold tracking-widest uppercase text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map(([domain, entry]) => (
              <tr key={domain} className="group hover:bg-surface-2/50 transition-colors">
                <td className="py-3 pr-6 font-medium text-slate-200">{domain}</td>
                <td className="py-3 pr-6">
                  <TierBadge tier={entry.lastSuccessfulTier} />
                </td>
                <td className="py-3 pr-6">
                  <select
                    value={entry.workingGeo ?? ''}
                    onChange={e => handleGeoChange(domain, e.target.value)}
                    className="bg-surface-3 border border-border hover:border-border-2 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-accent transition-colors cursor-pointer"
                  >
                    {GEO_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.value ? `${o.flag} ${o.value.toUpperCase()}` : '🌍 Auto'}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-3 pr-6 text-slate-500 text-xs font-mono">
                  {new Date(entry.lastScraped).toLocaleDateString()}&nbsp;
                  {new Date(entry.lastScraped).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="py-3">
                  <button
                    onClick={() => handleDelete(domain)}
                    title="Reset cached tier/geo — runs full re-detection on next scrape"
                    className="text-xs text-red-500/70 hover:text-red-400 border border-red-900/40 hover:border-red-800 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    Reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && filter && (
          <p className="text-center text-slate-600 text-sm py-6">No sites match &quot;{filter}&quot;</p>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [urlsText, setUrlsText]           = useState('');
  const [geo, setGeo]                     = useState('');
  const [scraping, setScraping]           = useState(false);
  const [logEvents, setLogEvents]         = useState<ProgressEvent[]>([]);
  const [siteStatuses, setSiteStatuses]   = useState<SiteStatus[]>([]);
  const [results, setResults]             = useState<ScrapeResult[]>([]);
  const [siteMemory, setSiteMemory]       = useState<SiteMemory>({});
  const [showMemory, setShowMemory]       = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [lightbox, setLightbox]           = useState<{ banner: BannerImage; domain: string } | null>(null);
  const [logExpanded, setLogExpanded]     = useState(false);
  const [logCopied, setLogCopied]         = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Prompts state
  const [promptsByDomain, setPromptsByDomain]   = useState<Record<string, PromptItem[]>>({});
  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [approvalState, setApprovalState]         = useState<Record<string, 'approved' | 'rejected'>>({});

  const checkBackend = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(5000) });
      setBackendOnline(r.ok);
    } catch {
      setBackendOnline(false);
    }
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/sites`);
      if (r.ok) setSiteMemory(await r.json());
    } catch { /* offline */ }
  }, []);

  useEffect(() => {
    checkBackend();
    loadMemory();
    const iv = setInterval(checkBackend, 10_000);
    return () => clearInterval(iv);
  }, [checkBackend, loadMemory]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEvents]);

  // URL validation
  const urlLines = useMemo(
    () => urlsText.split('\n').map(u => u.trim()).filter(Boolean),
    [urlsText]
  );
  const invalidUrls = useMemo(
    () => urlLines.filter(u => !isValidUrl(u)),
    [urlLines]
  );

  const startScrape = useCallback((urls: string[]) => {
    if (urls.length === 0 || scraping) return;

    setScraping(true);
    setLogEvents([]);
    setResults([]);
    setSiteStatuses(urls.map(url => ({
      domain: (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })(),
      url,
      state: 'pending',
    })));

    const params = new URLSearchParams({ urls: urls.join(',') });
    if (geo) params.set('geo', geo);

    const source = new EventSource(`${BACKEND}/scrape-stream?${params.toString()}`);

    source.onmessage = (e) => {
      let event: ProgressEvent;
      try { event = JSON.parse(e.data); } catch { return; }

      setLogEvents(prev => [...prev, event]);

      if (event.domain) {
        setSiteStatuses(prev => prev.map(s => {
          if (s.domain !== event.domain) return s;
          switch (event.type) {
            case 'site_start': return { ...s, state: 'running' };
            case 'tier':       return { ...s, state: 'running', currentTier: event.tier };
            case 'geo_try':    return { ...s, state: 'running', currentGeo: event.geo };
            case 'site_done':
              if (event.result?.success)
                return { ...s, state: 'done', result: event.result, currentTier: undefined, currentGeo: undefined };
              return { ...s, state: 'failed', message: event.result?.error, currentTier: undefined };
            default: return s;
          }
        }));
      }

      if (event.type === 'site_done' && event.result) {
        setResults(prev => {
          // Replace if already exists (rerun), otherwise append
          const exists = prev.findIndex(r => r.domain === event.result!.domain);
          if (exists >= 0) {
            const updated = [...prev];
            updated[exists] = event.result!;
            return updated;
          }
          return [...prev, event.result!];
        });
      }

      if (event.type === 'done' || event.type === 'error') {
        source.close();
        setScraping(false);
        loadMemory();
      }
    };

    source.onerror = () => {
      source.close();
      setScraping(false);
      setLogEvents(prev => [...prev, {
        type: 'error',
        message: 'Connection lost — is the backend running on port 3001?',
      }]);
    };
  }, [geo, scraping, loadMemory]);

  const handleScrape = useCallback(() => {
    if (invalidUrls.length > 0) return;
    startScrape(urlLines);
  }, [urlLines, invalidUrls, startScrape]);

  const handleRerun = useCallback((url: string) => {
    startScrape([url]);
  }, [startScrape]);

  const handleOpenLightbox = useCallback((banner: BannerImage, domain: string) => {
    setLightbox({ banner, domain });
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightbox(null);
  }, []);

  const exportResults = useCallback(() => {
    const data = JSON.stringify(results, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bannerbot-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  const copyLog = useCallback(() => {
    const text = logEvents.map(ev => formatLogEvent(ev)).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 2000);
    });
  }, [logEvents]);

  // Single webhook call with ALL sites → n8n processes all Drive folders → returns per-site prompts
  const handleGenerateAllPrompts = useCallback(async () => {
    const targets = results.filter(r => r.success);
    if (targets.length === 0) return;

    // Warn if any site has no Drive folder ID
    const missing = targets.filter(r => !r.driveFolderId).map(r => r.domain);
    if (missing.length === targets.length) {
      // None have Drive configured — show message on each card
      const fallback: Record<string, PromptItem[]> = {};
      for (const r of targets) {
        fallback[r.domain] = [{ prompt: 'Drive folder not found — enable GOOGLE_DRIVE_ROOT_FOLDER_ID + GOOGLE_SERVICE_ACCOUNT_KEY and re-scrape.' }];
      }
      setPromptsByDomain(prev => ({ ...prev, ...fallback }));
      return;
    }

    setGeneratingPrompts(true);

    const payload = {
      sites: targets.map(r => ({
        domain:         r.domain,
        driveFolderId:  r.driveFolderId ?? null,
        driveFolderUrl: r.driveFolderUrl ?? null,
      })),
    };

    try {
      const res = await fetch(`${BACKEND}/analyze-prompts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(300_000),
      });
      const data = await res.json();

      // Parse n8n response — handles several common shapes:
      //   [{ domain, prompts: [...] }]          ← preferred: array of site objects
      //   { sites: [{ domain, prompts }] }      ← wrapped
      //   { domain: "x", prompts: [...] }       ← single site
      //   [{ prompt: "...", imageUrl: "..." }]   ← flat prompt list (assign to first site)
      //   "string"                              ← plain text (assign to first site)
      const byDomain: Record<string, PromptItem[]> = {};

      const toItems = (raw: unknown): PromptItem[] => {
        if (Array.isArray(raw)) return raw as PromptItem[];
        if (typeof raw === 'string') return [{ prompt: raw }];
        if (raw && typeof raw === 'object') {
          const o = raw as Record<string, unknown>;
          if (typeof o.prompt === 'string') return [{ prompt: o.prompt }];
          if (typeof o.output === 'string') return [{ prompt: o.output }];
          if (typeof o.text === 'string')   return [{ prompt: o.text }];
          return [{ prompt: JSON.stringify(raw, null, 2) }];
        }
        return [{ prompt: String(raw) }];
      };

      const siteList: Array<{ domain: string; prompts: unknown }> | null =
        Array.isArray(data) && data.length > 0 && 'domain' in data[0] ? data :
        Array.isArray(data?.sites) ? data.sites :
        data?.domain ? [data] :
        null;

      if (siteList) {
        for (const entry of siteList) {
          byDomain[entry.domain] = toItems(entry.prompts);
        }
      } else {
        // Flat response — assign to all targets (they all share the same analysis)
        const items = toItems(data);
        for (const r of targets) byDomain[r.domain] = items;
      }

      setPromptsByDomain(prev => ({ ...prev, ...byDomain }));
    } catch (err) {
      const errItem: PromptItem[] = [{ prompt: `Error: ${(err as Error).message}` }];
      const errMap: Record<string, PromptItem[]> = {};
      for (const r of targets) errMap[r.domain] = errItem;
      setPromptsByDomain(prev => ({ ...prev, ...errMap }));
    } finally {
      setGeneratingPrompts(false);
    }
  }, [results]);

  const handleApprovePrompt = useCallback(async (
    domain: string,
    item: PromptItem,
    idx: number,
    approved: boolean,
  ) => {
    const key = `${domain}::${idx}`;
    setApprovalState(prev => ({ ...prev, [key]: approved ? 'approved' : 'rejected' }));

    await fetch(`${BACKEND}/approve-prompt`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ domain, prompt: item.prompt, imageUrl: item.imageUrl, approved }),
    }).catch(() => { /* non-critical */ });
  }, []);

  const urlCount = urlLines.length;
  const isActive = scraping || logEvents.length > 0;

  // Stats
  const successCount  = results.filter(r => r.success).length;
  const totalBanners  = results.reduce((s, r) => s + r.homepageBanners.length + r.promoBanners.length, 0);
  const tierNums      = results.filter(r => r.success && r.tier > 0).map(r => r.tier);
  const avgTier       = tierNums.length > 0
    ? (tierNums.reduce((a, b) => a + b, 0) / tierNums.length).toFixed(1)
    : '—';

  return (
    <main className="relative min-h-screen text-slate-100 py-8 px-4 sm:px-6 lg:px-10">
      {/* Lightbox */}
      {lightbox && (
        <LightboxModal
          banner={lightbox.banner}
          domain={lightbox.domain}
          onClose={handleCloseLightbox}
        />
      )}

      <div className="relative z-10 max-w-6xl mx-auto space-y-6">

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <header className="flex items-center justify-between py-2">
          <div className="flex items-center gap-3.5">
            <LogoIcon size={38} />
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-100">
                BannerBot
              </h1>
              <p className="text-[11px] text-slate-500 tracking-widest uppercase mt-0.5">
                Casino Intelligence Platform
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <BackendStatus connected={backendOnline} />
            <span className="hidden sm:block text-[10px] font-mono text-border-2 border border-border px-2 py-1 rounded-md">
              v2.1
            </span>
          </div>
        </header>

        {/* ── Input card ────────────────────────────────────────────────────── */}
        <section className="card p-6 space-y-5">

          {/* Step label */}
          <div className="section-label">
            <span className="step-num">01</span>
            Target URLs
          </div>

          {/* URL textarea */}
          <div className="space-y-1.5">
            <textarea
              value={urlsText}
              onChange={e => setUrlsText(e.target.value)}
              placeholder={"https://www.bet365.com\nhttps://www.casumo.com\nhttps://www.novadreams.com"}
              rows={5}
              disabled={scraping}
              className={`w-full bg-surface-3 border ${invalidUrls.length > 0 ? 'border-red-700/60' : 'border-border hover:border-border-2'} focus:border-accent rounded-xl p-4 text-sm font-mono text-slate-100 placeholder-slate-700 focus:outline-none transition-colors resize-y disabled:opacity-50 leading-relaxed`}
            />
            {invalidUrls.length > 0 && (
              <div className="flex items-start gap-1.5 text-[11px] text-red-400">
                <span className="flex-shrink-0 mt-0.5">⚠</span>
                <span>
                  {invalidUrls.length} invalid URL{invalidUrls.length > 1 ? 's' : ''}:&nbsp;
                  <span className="font-mono">{invalidUrls.slice(0, 2).join(', ')}{invalidUrls.length > 2 ? ` +${invalidUrls.length - 2} more` : ''}</span>
                  &nbsp;— must include https://
                </span>
              </div>
            )}
          </div>

          {/* Controls row */}
          <div className="flex flex-wrap items-center gap-3">

            {/* Geo picker */}
            <div className="flex items-center gap-2.5">
              <div className="section-label text-[10px]">
                <span className="step-num">02</span>
                Geo
              </div>
              <select
                value={geo}
                onChange={e => setGeo(e.target.value)}
                disabled={scraping}
                className="bg-surface-3 border border-border hover:border-border-2 focus:border-accent rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none transition-colors disabled:opacity-50 cursor-pointer"
              >
                {GEO_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.flag}&nbsp; {o.label}
                  </option>
                ))}
              </select>
            </div>

            {geo === '' ? (
              <span className="text-[11px] text-slate-600 hidden sm:block">
                Auto-detect — uses stored geo or tries all countries
              </span>
            ) : (
              <span className="text-[11px] text-accent-light hidden sm:block">
                Force {geo.toUpperCase()} for all sites this run
              </span>
            )}

            {/* Scrape button */}
            <button
              onClick={handleScrape}
              disabled={scraping || urlCount === 0 || !backendOnline || invalidUrls.length > 0}
              className="btn-primary ml-auto flex items-center gap-2.5 text-sm"
            >
              {scraping ? (
                <>
                  <span className="spin text-base">⟳</span>
                  Scraping…
                </>
              ) : (
                <>
                  <span>▶</span>
                  Scrape{urlCount > 0 ? ` ${urlCount} site${urlCount !== 1 ? 's' : ''}` : ''}
                </>
              )}
            </button>
          </div>

          {/* Offline warning */}
          {!backendOnline && (
            <div className="flex items-start gap-3 text-[12px] text-red-400/90 bg-red-950/20 border border-red-900/30 rounded-xl px-4 py-3">
              <span className="mt-0.5 flex-shrink-0">⚠</span>
              <span>
                Backend offline — run&nbsp;
                <code className="font-mono text-red-300 bg-red-950/40 px-1.5 py-0.5 rounded">npm run server</code>
                &nbsp;from the BannerScrapper folder.
              </span>
            </div>
          )}
        </section>

        {/* ── Progress ──────────────────────────────────────────────────────── */}
        {isActive && (
          <section className={`card overflow-hidden ${scraping ? 'active' : ''}`}>
            {/* Section header */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border bg-surface-2/50">
              <div className="section-label">
                {scraping
                  ? <><span className="spin text-amber-400">⟳</span> Live</>
                  : '● Complete'
                }
              </div>
              {siteStatuses.length > 0 && (
                <span className="ml-auto text-[11px] text-slate-600">
                  {siteStatuses.filter(s => s.state === 'done').length}/
                  {siteStatuses.length} done
                </span>
              )}
            </div>

            <div className={`${siteStatuses.length > 0 ? 'grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border' : ''}`}>

              {/* Site status list */}
              {siteStatuses.length > 0 && (
                <div className="p-4 space-y-2">
                  <div className="section-label mb-3">Sites</div>
                  {siteStatuses.map(s => <SiteStatusCard key={s.domain} site={s} />)}
                </div>
              )}

              {/* Terminal log */}
              <div className="p-4">
                <div className="flex items-center mb-3">
                  <div className="section-label">Terminal</div>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      onClick={copyLog}
                      className="text-[11px] text-slate-600 hover:text-slate-300 border border-border hover:border-border-2 px-2 py-0.5 rounded-md transition-colors"
                    >
                      {logCopied ? '✓ Copied' : 'Copy'}
                    </button>
                    <button
                      onClick={() => setLogExpanded(v => !v)}
                      className="text-[11px] text-slate-600 hover:text-slate-300 border border-border hover:border-border-2 px-2 py-0.5 rounded-md transition-colors"
                    >
                      {logExpanded ? '⊟ Collapse' : '⊞ Expand'}
                    </button>
                  </div>
                </div>
                <div className={`terminal overflow-y-auto p-3 space-y-0.5 transition-all duration-300 ${logExpanded ? 'h-auto max-h-[600px]' : 'h-52'}`}>
                  {logEvents.map((ev, i) => (
                    <div key={i} className={`log-entry flex gap-2 items-baseline ${logLineColor(ev.type)}`}>
                      <span className="flex-shrink-0 w-3 text-center">{logLinePrefix(ev.type)}</span>
                      <span className="break-all">{formatLogEvent(ev)}</span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── Results ───────────────────────────────────────────────────────── */}
        {results.length > 0 && (
          <section className="space-y-4">
            {/* Header + stats */}
            <div className="flex items-center gap-3">
              <div className="section-label">
                <span className="step-num">Results</span>
                <span className="text-slate-600 font-normal normal-case tracking-normal text-xs ml-1">
                  {successCount} of {results.length} succeeded
                </span>
              </div>
              <div className="flex items-center gap-2 ml-auto flex-wrap justify-end">
                {/* Stats chips */}
                <span className="text-[11px] text-slate-500 hidden sm:flex items-center gap-3 mr-1">
                  <span className="text-emerald-400/80">{totalBanners} banners</span>
                  <span>avg tier {avgTier}</span>
                </span>
                {/* Generate Prompts — single call for all sites */}
                {results.some(r => r.success) && (
                  <button
                    onClick={handleGenerateAllPrompts}
                    disabled={generatingPrompts}
                    className="text-[11px] text-slate-200 hover:text-accent border border-border hover:border-accent/60 px-3 py-1 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {generatingPrompts
                      ? <><span className="spin text-[10px]">⟳</span> Analyzing…</>
                      : <><span>✦</span> Generate Prompts</>
                    }
                  </button>
                )}
                {/* Export */}
                <button
                  onClick={exportResults}
                  className="text-[11px] text-slate-400 hover:text-slate-200 border border-border hover:border-border-2 px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1"
                >
                  ↓ Export JSON
                </button>
              </div>
            </div>

            {results.map(r => (
              <ResultCard
                key={r.domain}
                result={r}
                onRerun={handleRerun}
                onOpenLightbox={handleOpenLightbox}
                canRerun={!scraping}
                promptsLoading={generatingPrompts}
                prompts={promptsByDomain[r.domain] ?? null}
                approvalState={approvalState}
                onApprove={handleApprovePrompt}
              />
            ))}
          </section>
        )}

        {/* ── Site Memory ───────────────────────────────────────────────────── */}
        <section className="card overflow-hidden">
          <button
            onClick={() => {
              setShowMemory(v => !v);
              if (!showMemory) loadMemory();
            }}
            className="w-full flex items-center gap-3 px-5 py-4 hover:bg-surface-2/40 transition-colors text-left"
          >
            <div className="section-label flex-1">
              <span className="step-num">Memory</span>
              Site Cache
            </div>
            <span className="text-[11px] text-slate-600">
              {Object.keys(siteMemory).length} site{Object.keys(siteMemory).length !== 1 ? 's' : ''}
            </span>
            <span className={`text-slate-600 text-xs transition-transform duration-200 ${showMemory ? 'rotate-180' : ''}`}>
              ▾
            </span>
          </button>

          {showMemory && (
            <div className="border-t border-border px-5 pb-5">
              <p className="text-[11px] text-slate-600 py-3">
                Change a site&apos;s geo to force a specific country on next scrape.
                &nbsp;<strong className="text-slate-500">Reset</strong> clears cached tier and geo — runs full re-detection.
              </p>
              <SiteMemoryTable memory={siteMemory} onUpdate={loadMemory} />
            </div>
          )}
        </section>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <footer className="text-center text-[11px] text-slate-700 pb-4">
          BannerBot · 4-tier progressive escalation · Tier 1 vanilla → Tier 4 residential proxy
        </footer>

      </div>
    </main>
  );
}

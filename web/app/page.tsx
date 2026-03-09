'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// ── Config ─────────────────────────────────────────────────────────────────────
// Local dev: set NEXT_PUBLIC_BACKEND_URL=http://localhost:3001 in web/.env.local
// Production: set NEXT_PUBLIC_BACKEND_URL=https://your-cloud-run-url.run.app in Vercel
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

const GEO_OPTIONS = [
  { value: '',   label: 'Auto-detect',        flag: '🌍' },
  { value: 'ph', label: 'Philippines',         flag: '🇵🇭' },
  { value: 'ca', label: 'Canada',              flag: '🇨🇦' },
  { value: 'gb', label: 'United Kingdom',      flag: '🇬🇧' },
  { value: 'au', label: 'Australia',           flag: '🇦🇺' },
  { value: 'se', label: 'Sweden',              flag: '🇸🇪' },
  { value: 'in', label: 'India',               flag: '🇮🇳' },
  { value: 'us', label: 'United States',       flag: '🇺🇸' },
  { value: 'de', label: 'Germany',             flag: '🇩🇪' },
  { value: 'nz', label: 'New Zealand',         flag: '🇳🇿' },
  { value: 'sg', label: 'Singapore',           flag: '🇸🇬' },
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

// ── Per-site status tracker (from SSE events) ─────────────────────────────────
interface SiteStatus {
  domain: string;
  url: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  currentTier?: number;
  currentGeo?: string;
  message?: string;
  result?: ScrapeResult;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bannerImageUrl(domain: string, localPath?: string): string {
  if (!localPath) return '';
  const filename = localPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return `${BACKEND}/banners/${domain}/${filename}`;
}

function tierBadge(tier: number) {
  const colors: Record<number, string> = {
    1: 'bg-green-900 text-green-300',
    2: 'bg-blue-900 text-blue-300',
    3: 'bg-amber-900 text-amber-300',
    4: 'bg-red-900 text-red-300',
  };
  const labels: Record<number, string> = {
    1: 'T1 Vanilla', 2: 'T2 Stealth', 3: 'T3 Proxy', 4: 'T4 Res',
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${colors[tier] ?? 'bg-slate-700 text-slate-300'}`}>
      {labels[tier] ?? `Tier ${tier}`}
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
    case 'done':       return 'text-emerald-300 font-semibold';
    case 'error':      return 'text-red-300';
    case 'progress':   return 'text-slate-500';
    default:           return 'text-slate-400';
  }
}

function logLineIcon(type: string): string {
  switch (type) {
    case 'site_start': return '▶';
    case 'tier':       return '○';
    case 'geo_try':    return '⟳';
    case 'tier_fail':  return '✗';
    case 'site_done':  return '●';
    case 'done':       return '✓';
    case 'error':      return '!';
    case 'progress':   return '…';
    default:           return '·';
  }
}

function formatLogEvent(ev: ProgressEvent): string {
  if (ev.message) return ev.message;
  switch (ev.type) {
    case 'start':      return `Starting batch of ${ev.total} site${(ev.total ?? 0) > 1 ? 's' : ''}`;
    case 'site_start': return `[${ev.domain}] Starting scrape`;
    case 'tier':       return `[${ev.domain}] ${ev.message ?? `Tier ${ev.tier}`}`;
    case 'geo_try':    return `[${ev.domain}] Trying geo: ${(ev.geo ?? '').toUpperCase()}`;
    case 'tier_fail':  return `[${ev.domain}] Tier ${ev.tier}${ev.geo ? ` (${ev.geo.toUpperCase()})` : ''} failed: ${ev.reason ?? 'unknown'}`;
    case 'site_done':
      if (ev.result?.success)
        return `[${ev.domain}] ✓ Tier ${ev.result.tier}${ev.result.geo ? ` (${ev.result.geo.toUpperCase()})` : ''} — ${ev.result.homepageBanners.length} home + ${ev.result.promoBanners.length} promo banners`;
      return `[${ev.domain}] ✗ Failed — ${ev.result?.error ?? 'all tiers exhausted'}`;
    case 'done':       return `Batch complete — ${ev.results?.length ?? 0} site(s) processed`;
    default:           return ev.message ?? ev.type;
  }
}

// ── Components ────────────────────────────────────────────────────────────────

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} />
      {connected ? 'Backend connected' : 'Backend offline'}
    </span>
  );
}

function SiteStatusRow({ site }: { site: SiteStatus }) {
  const stateIcon = {
    pending: <span className="text-slate-500">○</span>,
    running: <span className="pulse-amber text-amber-400">⟳</span>,
    done:    <span className="text-emerald-400">✓</span>,
    failed:  <span className="text-red-400">✗</span>,
  }[site.state];

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
      <span className="text-lg">{stateIcon}</span>
      <span className="font-medium text-slate-200 truncate max-w-[200px]">{site.domain}</span>
      {site.currentTier !== undefined && site.state === 'running' && (
        <span className="text-xs text-slate-500">
          Tier {site.currentTier}
          {site.currentGeo ? ` · ${(GEO_FLAGS[site.currentGeo] ?? '')} ${site.currentGeo.toUpperCase()}` : ''}
        </span>
      )}
      {site.result && (
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          {tierBadge(site.result.tier)}
          {site.result.geo && <span>{GEO_FLAGS[site.result.geo] ?? site.result.geo.toUpperCase()}</span>}
          <span className="text-slate-300">
            {site.result.homepageBanners.length}hp + {site.result.promoBanners.length}pr
          </span>
        </div>
      )}
      {site.state === 'failed' && !site.result && (
        <span className="ml-auto text-xs text-red-400 truncate max-w-[200px]">{site.message ?? 'Failed'}</span>
      )}
    </div>
  );
}

function BannerCard({ banner, domain }: { banner: BannerImage; domain: string }) {
  const imgUrl = banner.gcsUrl || bannerImageUrl(domain, banner.localPath);
  const [loaded, setLoaded] = useState(false);
  const [error, setError]   = useState(false);
  const label = banner.page === 'promotions' ? 'Promo' : 'Home';

  return (
    <div className="group relative rounded-lg overflow-hidden border border-slate-700 hover:border-amber-500 transition-colors bg-slate-800">
      {/* Page type badge */}
      <span className={`absolute top-1.5 left-1.5 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded ${
        banner.page === 'promotions'
          ? 'bg-violet-700 text-violet-100'
          : 'bg-sky-800 text-sky-200'
      }`}>
        {label}
      </span>

      {/* Image */}
      <a href={banner.src} target="_blank" rel="noopener noreferrer">
        {!error ? (
          <img
            src={imgUrl || banner.src}
            alt={banner.altText ?? `Banner ${banner.width}×${banner.height}`}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            className={`w-full object-cover transition-opacity ${loaded ? 'opacity-100' : 'opacity-0'}`}
            style={{ aspectRatio: `${Math.min(banner.aspectRatio, 4)} / 1` }}
          />
        ) : (
          // Fallback: link to original source
          <div className="flex items-center justify-center h-20 text-slate-600 text-sm">
            Image not cached (click to view original)
          </div>
        )}
        {!loaded && !error && (
          <div className="absolute inset-0 bg-slate-700 animate-pulse" />
        )}
      </a>

      {/* Meta */}
      <div className="px-2 py-1.5 text-[11px] text-slate-400 flex justify-between">
        <span>{banner.width}×{banner.height}</span>
        <span className="text-slate-600">score {banner.score.toFixed(0)}</span>
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: ScrapeResult }) {
  const allBanners = [...result.homepageBanners, ...result.promoBanners];
  return (
    <div className="border border-slate-700 rounded-xl overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-800">
        <span className={result.success ? 'text-emerald-400 text-xl' : 'text-red-400 text-xl'}>
          {result.success ? '✓' : '✗'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-100">{result.domain}</div>
          <div className="text-xs text-slate-500 truncate">{result.url}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {result.success && tierBadge(result.tier)}
          {result.geo && (
            <span className="text-sm" title={result.geo.toUpperCase()}>
              {GEO_FLAGS[result.geo] ?? result.geo.toUpperCase()}
            </span>
          )}
          {result.success && (
            <span className="text-xs text-slate-400">
              {allBanners.length} banner{allBanners.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Banners grid */}
      {allBanners.length > 0 ? (
        <div className="p-3 bg-slate-900/50 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {allBanners.map((b, i) => (
            <BannerCard key={`${b.src}-${i}`} banner={b} domain={result.domain} />
          ))}
        </div>
      ) : result.success ? (
        <div className="px-4 py-3 text-slate-500 text-sm">No banners detected</div>
      ) : (
        <div className="px-4 py-3 text-red-400 text-sm">{result.error}</div>
      )}
    </div>
  );
}

function SiteMemoryTable({ memory, onUpdate }: { memory: SiteMemory; onUpdate: () => void }) {
  const entries = Object.entries(memory).sort((a, b) =>
    new Date(b[1].lastScraped).getTime() - new Date(a[1].lastScraped).getTime()
  );

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

  if (entries.length === 0) {
    return <p className="mt-4 text-slate-500 text-sm">No sites scraped yet.</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-slate-500 text-xs border-b border-slate-700">
            <th className="pb-2 pr-4 font-medium">Domain</th>
            <th className="pb-2 pr-4 font-medium">Tier</th>
            <th className="pb-2 pr-4 font-medium">Geo</th>
            <th className="pb-2 pr-4 font-medium">Last scraped</th>
            <th className="pb-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([domain, entry]) => (
            <tr key={domain} className="border-b border-slate-800 hover:bg-slate-800/30">
              <td className="py-2 pr-4 text-slate-200 font-medium">{domain}</td>
              <td className="py-2 pr-4">{tierBadge(entry.lastSuccessfulTier)}</td>
              <td className="py-2 pr-4">
                <select
                  value={entry.workingGeo ?? ''}
                  onChange={e => handleGeoChange(domain, e.target.value)}
                  className="bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                >
                  {GEO_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.value ? `${o.flag} ${o.value.toUpperCase()}` : 'Auto'}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-4 text-slate-500 text-xs">
                {new Date(entry.lastScraped).toLocaleDateString()} {new Date(entry.lastScraped).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="py-2">
                <button
                  onClick={() => handleDelete(domain)}
                  title="Reset — remove from memory so tier re-detection runs on next scrape"
                  className="text-red-500 hover:text-red-400 text-xs px-2 py-0.5 rounded border border-red-900 hover:border-red-500 transition-colors"
                >
                  Reset
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [urlsText, setUrlsText]       = useState('');
  const [geo, setGeo]                 = useState('');
  const [scraping, setScraping]       = useState(false);
  const [logEvents, setLogEvents]     = useState<ProgressEvent[]>([]);
  const [siteStatuses, setSiteStatuses] = useState<SiteStatus[]>([]);
  const [results, setResults]         = useState<ScrapeResult[]>([]);
  const [siteMemory, setSiteMemory]   = useState<SiteMemory>({});
  const [showMemory, setShowMemory]   = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // ── Check backend health ──────────────────────────────────────────────────
  const checkBackend = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(5000) });
      setBackendOnline(r.ok);
    } catch {
      setBackendOnline(false);
    }
  }, [BACKEND]);

  // ── Load site memory ──────────────────────────────────────────────────────
  const loadMemory = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/sites`);
      if (r.ok) setSiteMemory(await r.json());
    } catch { /* offline */ }
  }, [BACKEND]);

  useEffect(() => {
    checkBackend();
    loadMemory();
    const iv = setInterval(checkBackend, 10_000);
    return () => clearInterval(iv);
  }, [checkBackend, loadMemory]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEvents]);

  // ── Start scrape ──────────────────────────────────────────────────────────
  const handleScrape = useCallback(() => {
    const urls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);
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

      // Update per-site status
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
        setResults(prev => [...prev, event.result!]);
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
        message: 'Connection to backend lost. Is the server running on port 3001?',
      }]);
    };
  }, [urlsText, geo, scraping, loadMemory]);

  const urlCount = urlsText.split('\n').filter(l => l.trim()).length;

  return (
    <main className="min-h-screen bg-[#0a0f1a] text-slate-100 p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-amber-400">
              🎰 Casino Banner Scraper
            </h1>
            <p className="text-slate-500 text-sm mt-0.5">
              Progressive-tier scraper with auto geo-detection
            </p>
          </div>
          <StatusDot connected={backendOnline} />
        </div>

        {/* ── URL Input card ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Target URLs
              <span className="text-slate-600 font-normal ml-2">(one per line)</span>
            </label>
            <textarea
              value={urlsText}
              onChange={e => setUrlsText(e.target.value)}
              placeholder={"https://www.bet365.com\nhttps://www.casumo.com\nhttps://www.novadreams.com"}
              rows={5}
              disabled={scraping}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-sm font-mono text-slate-100 placeholder-slate-700 focus:outline-none focus:border-amber-500 transition-colors resize-y disabled:opacity-50"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {/* Geo selector */}
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-400 whitespace-nowrap">Geo override:</label>
              <select
                value={geo}
                onChange={e => setGeo(e.target.value)}
                disabled={scraping}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500 transition-colors disabled:opacity-50"
              >
                {GEO_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.flag} {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-xs text-slate-600">
              {geo === ''
                ? 'Will use stored geo from memory, or auto-detect on first visit'
                : `Will force ${geo.toUpperCase()} for all sites this run`}
            </div>

            {/* Scrape button */}
            <button
              onClick={handleScrape}
              disabled={scraping || urlCount === 0 || !backendOnline}
              className="ml-auto flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-600 disabled:border disabled:border-slate-700 text-slate-950 font-bold px-5 py-2 rounded-xl transition-all"
            >
              {scraping ? (
                <><span className="pulse-amber">⟳</span> Scraping…</>
              ) : (
                <>▶ Scrape {urlCount > 0 ? `${urlCount} site${urlCount !== 1 ? 's' : ''}` : ''}</>
              )}
            </button>
          </div>

          {!backendOnline && (
            <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2">
              Backend is offline. Start it with: <code className="font-mono bg-slate-800 px-1 rounded">npm run server</code> (from the BannerScrapper folder)
            </p>
          )}
        </section>

        {/* ── Progress section ── */}
        {(scraping || logEvents.length > 0) && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-200">
              {scraping ? <><span className="pulse-amber">⟳</span> Scraping in progress…</> : 'Progress log'}
            </h2>

            {/* Per-site status cards */}
            {siteStatuses.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {siteStatuses.map(s => <SiteStatusRow key={s.domain} site={s} />)}
              </div>
            )}

            {/* SSE log */}
            <div className="bg-slate-950 rounded-xl p-3 h-48 overflow-y-auto font-mono text-xs space-y-0.5">
              {logEvents.map((ev, i) => (
                <div key={i} className={`log-entry flex gap-2 ${logLineColor(ev.type)}`}>
                  <span className="flex-shrink-0 w-3">{logLineIcon(ev.type)}</span>
                  <span>{formatLogEvent(ev)}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </section>
        )}

        {/* ── Results ── */}
        {results.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-base font-semibold text-slate-200">
              Results
              <span className="text-slate-600 font-normal ml-2">
                — {results.filter(r => r.success).length}/{results.length} succeeded
              </span>
            </h2>
            {results.map(r => (
              <ResultCard key={r.domain} result={r} />
            ))}
          </section>
        )}

        {/* ── Site Memory ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <button
            onClick={() => {
              setShowMemory(v => !v);
              if (!showMemory) loadMemory();
            }}
            className="flex items-center gap-2 text-base font-semibold text-slate-200 hover:text-amber-400 transition-colors"
          >
            <span className="text-slate-500">{showMemory ? '▼' : '▶'}</span>
            Site Memory
            <span className="text-slate-600 font-normal text-sm ml-1">
              — {Object.keys(siteMemory).length} site{Object.keys(siteMemory).length !== 1 ? 's' : ''} cached
            </span>
          </button>

          {showMemory && (
            <>
              <p className="text-xs text-slate-600 mt-2">
                Change a site's geo to force a specific country next time it's scraped.
                Click <strong>Reset</strong> to clear cached tier/geo (runs full re-detection on next scrape).
              </p>
              <SiteMemoryTable memory={siteMemory} onUpdate={loadMemory} />
            </>
          )}
        </section>

      </div>
    </main>
  );
}

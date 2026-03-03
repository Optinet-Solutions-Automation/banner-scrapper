/**
 * progress-emitter.ts — Global EventEmitter for scraping progress events.
 * Used by the orchestrator to emit events, and by the HTTP server's SSE
 * endpoint to stream them to the frontend in real-time.
 */
import { EventEmitter } from 'events';
import { ScrapeResult } from './types';

export interface ProgressEvent {
  type:
    | 'start'       // batch started
    | 'site_start'  // single site scrape started
    | 'tier'        // trying a tier
    | 'tier_fail'   // a tier attempt failed
    | 'geo_try'     // auto-geo: trying a specific country
    | 'progress'    // informational message
    | 'site_done'   // single site scrape finished (success or failure)
    | 'done';       // entire batch finished

  // Common fields
  domain?: string;
  url?: string;
  message?: string;

  // Tier/geo context
  tier?: number;
  reason?: string;
  geo?: string;

  // Payload fields
  result?: ScrapeResult;
  results?: ScrapeResult[];
  total?: number;
}

export const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(50);  // support many concurrent SSE listeners

export function emitProgress(event: ProgressEvent): void {
  progressEmitter.emit('progress', event);
}

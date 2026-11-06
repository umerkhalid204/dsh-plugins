#!/usr/bin/env node
/**
 * career-ops DSH plugin: zero-token liveness check without Playwright.
 *
 * Wraps career-ops' own `liveness-api.mjs` (public ATS APIs) and falls back to
 * a plain fetch + `liveness-core.mjs` classifier when the URL is not a known
 * ATS posting. Prints one JSON object on stdout:
 *   { url, result, code, reason, source }
 * `result` is `active` | `expired` | `uncertain`; `uncertain` means "not
 * confirmed dead" and never closes a posting on its own.
 */
import { checkLivenessViaApi } from './liveness-api.mjs';
import { classifyLiveness } from './liveness-core.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';

const url = process.argv[2];
if (!url) {
  console.error('usage: node dsh-liveness.mjs <job-url>');
  process.exit(2);
}

const out = (payload) => {
  process.stdout.write(JSON.stringify({ url, ...payload }, null, 2) + '\n');
};

try {
  const api = await checkLivenessViaApi(url);
  if (api) {
    out({ ...api, source: 'ats-api' });
    process.exit(0);
  }

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'text/html,*/*' },
  });
  const body = await res.text();
  const verdict = classifyLiveness({
    status: res.status,
    requestedUrl: url,
    finalUrl: res.url || url,
    bodyText: body,
  });
  out({ ...verdict, source: 'fetch-classifier' });
  process.exit(0);
} catch (error) {
  out({
    result: 'uncertain',
    code: 'check-failed',
    reason: error?.message || String(error),
    source: 'error',
  });
  process.exit(0);
}

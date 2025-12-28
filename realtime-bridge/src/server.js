import crypto from 'crypto';
import http from 'http';
import fetch from 'node-fetch';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '8080', 10);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2025-08-28';
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// Tool execution logging:
//  - none: no tool logs beyond existing
//  - errors: log only failed tool executions (default)
//  - all: log every tool execution + tool output send
const TOOL_LOG_LEVEL_RAW = (process.env.TOOL_LOG_LEVEL || 'errors').toString().toLowerCase();
const TOOL_LOG_LEVEL = ['none', 'errors', 'all'].includes(TOOL_LOG_LEVEL_RAW) ? TOOL_LOG_LEVEL_RAW : 'errors';

// Tool-event shape logging (IDs / raw-ish) to debug Realtime tool arg streaming.
//  - none: disabled
//  - ids: log tool-related event id fields + argument lengths
//  - verbose: include a short prefix of argument text
const TOOL_EVENT_LOG_LEVEL_RAW = (process.env.TOOL_EVENT_LOG_LEVEL || 'none').toString().toLowerCase();
const TOOL_EVENT_LOG_LEVEL = ['none', 'ids', 'verbose'].includes(TOOL_EVENT_LOG_LEVEL_RAW)
  ? TOOL_EVENT_LOG_LEVEL_RAW
  : 'none';

const TWILIO_STREAM_HMAC_SECRET = process.env.TWILIO_STREAM_HMAC_SECRET;

const SITREP_BASE_URL = process.env.SITREP_BASE_URL || 'https://your-postgrest-instance.example.com';
const CYBERSCAPE_NEXUS_BASE_URL = process.env.CYBERSCAPE_NEXUS_BASE_URL || 'https://your-nexus-instance.example.com';

const SITREP_WINDOW_HOURS = parseInt(process.env.SITREP_WINDOW_HOURS || '24', 10);

// In-memory cache refresh interval. Default: 30 minutes.
// Keep SITREP_CACHE_TTL_SECONDS for backward compatibility.
const SITREP_REFRESH_SECONDS = parseInt(
  process.env.SITREP_REFRESH_SECONDS || process.env.SITREP_CACHE_TTL_SECONDS || '1800',
  10,
);

// How many hourly reports to keep cached (default 7 days * 24 hours = 168).
const SITREP_HOURLY_HISTORY_HOURS = parseInt(process.env.SITREP_HOURLY_HISTORY_HOURS || '168', 10);

let sitrepCache = {
  fetchedAtMs: 0,
  data: null,
  refreshInFlight: null,
  lastError: null,
  lastOkAtMs: 0,
  lastOkCounts: null,
};

if (!OPENAI_API_KEY) {
  throw new Error('Missing required env var OPENAI_API_KEY');
}
if (!TWILIO_STREAM_HMAC_SECRET) {
  throw new Error('Missing required env var TWILIO_STREAM_HMAC_SECRET');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signToken(payloadJson) {
  return crypto.createHmac('sha256', TWILIO_STREAM_HMAC_SECRET).update(payloadJson).digest('hex');
}

function verifyToken(token) {
  // Token format: base64url(payloadJson).hex(hmac)
  // payloadJson: { exp: <unix seconds>, callSid?: string, agent?: 'odin'|'rizzy' }
  const parts = (token || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad_format' };
  const [payloadB64, sig] = parts;

  let payloadJson;
  try {
    payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'bad_b64' };
  }

  const expected = signToken(payloadJson);
  if (!timingSafeEq(expected, sig)) return { ok: false, reason: 'bad_sig' };

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'bad_json' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' };

  const agent = payload.agent || 'odin';
  if (!['odin', 'rizzy'].includes(agent)) return { ok: false, reason: 'bad_agent' };

  return { ok: true, payload: { ...payload, agent } };
}

function looksCyber(text) {
  const t = (text || '').toString().toLowerCase();
  if (!t) return false;

  // Very lightweight “cyber-ish” heuristic to keep the voice agent on-topic.
  // We prefer false-negatives over letting random non-cyber content through.
  const needles = [
    'cve-',
    'vulnerability',
    'zero-day',
    '0-day',
    'exploit',
    'rce',
    'privilege escalation',
    'malware',
    'ransomware',
    'backdoor',
    'botnet',
    'phishing',
    'credential',
    'breach',
    'apt',
    'espionage',
    'ddos',
    'dns poisoning',
    'supply chain',
    'patch',
    'cisa',
    'kev',
    'ioc',
    'tactic',
    'ttp',
    'mitre',
  ];

  return needles.some((n) => t.includes(n));
}

function filterCyberEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];

  // Keep anything with explicit severity, or clearly cyber words in title/summary.
  return list
    .filter((e) => {
      const sev = (e?.severity_level || '').toString().toUpperCase();
      if (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(sev)) return true;

      const title = e?.title || '';
      const impact = e?.summary_impact || '';
      return looksCyber(title) || looksCyber(impact);
    })
    .slice(0, 25);
}

function buildBriefingForModel(sitrep) {
  const s = sitrep || {};
  const daily = s.daily_insights_latest || {};

  const allEntries = Array.isArray(s.analysis_entries_lite_7d) ? s.analysis_entries_lite_7d : [];
  const allRecent = Array.isArray(s.analysis_entries_lite_recent) ? s.analysis_entries_lite_recent : [];
  const cyberEntries =
    Array.isArray(s.analysis_entries_lite_7d_cyber) && s.analysis_entries_lite_7d_cyber.length
      ? s.analysis_entries_lite_7d_cyber
      : filterCyberEntries(allEntries);

  const cyberRecent = filterCyberEntries(allRecent);

  const hourlyLatest = s.hourly_sitrep_latest || null;
  const hourlyHistory = Array.isArray(s.hourly_sitreps_history) ? s.hourly_sitreps_history : [];

  function excerptReport(report, maxLen = 1800) {
    const t = (report || '').toString().trim();
    if (!t) return null;
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
  }

  // Reduce size and remove noisy fields.
  return {
    fetched_at: s.fetched_at,
    cache: s.cache || null,
    errors: s.errors || null,

    window: daily?.window || hourlyLatest?.window || null,

    // IMPORTANT: include the generated hourly SITREP text; this prevents the
    // model from thinking it has “no data” when daily insights or entries are sparse.
    hourly_sitrep_latest: hourlyLatest
      ? {
          generated_at: hourlyLatest.generated_at || null,
          window_start: hourlyLatest.window_start || null,
          window_end: hourlyLatest.window_end || null,
          report_excerpt: excerptReport(hourlyLatest.report),
        }
      : null,

    // A few recent hourly excerpts (most recent first). Keep small for token budget.
    hourly_sitreps_recent: hourlyHistory
      .slice(0, Math.min(24, hourlyHistory.length))
      .map((h) => ({
        generated_at: h?.generated_at || null,
        window_start: h?.window_start || null,
        window_end: h?.window_end || null,
        report_excerpt: excerptReport(h?.report, 800),
      }))
      .filter((h) => h.report_excerpt),

    hot_cves: Array.isArray(daily?.hot_cves) ? daily.hot_cves.slice(0, 10) : [],

    top_sources: Array.isArray(daily?.top_sources) ? daily.top_sources.slice(0, 10) : [],

    top_clusters: Array.isArray(daily?.top_clusters)
      ? daily.top_clusters.filter((c) => looksCyber(c?.title) || looksCyber(JSON.stringify(c))).slice(0, 12)
      : [],

    stats_severity_by_source_7d: Array.isArray(s.stats_severity_by_source_7d) ? s.stats_severity_by_source_7d : [],

    // Recent headlines (past window, newest first). Keep small for token budget.
    headlines_recent: cyberRecent.slice(0, 10).map((e) => ({
      title: e?.title,
      source_name: e?.source_name,
      published: e?.published,
      severity_level: e?.severity_level || null,
      confidence_pct: e?.confidence_pct ?? null,
      summary_impact: e?.summary_impact || null,
      link: e?.link || null,
    })),

    notable_entries_7d: cyberEntries.map((e) => ({
      title: e?.title,
      source_name: e?.source_name,
      published: e?.published,
      severity_level: e?.severity_level || null,
      confidence_pct: e?.confidence_pct ?? null,
      summary_impact: e?.summary_impact || null,
      link: e?.link || null,
    })),

    non_cyber_entries_filtered_out: Math.max(0, allEntries.length - cyberEntries.length),
  };
}

async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    }

    const data = await r.json();
    return { ok: true, data };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `timeout_after_${timeoutMs}ms` : err?.message || String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithRetries(url, attempts = 3, timeoutMs = 5000) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300 * i));
    last = await fetchWithTimeout(url, timeoutMs);
    if (last.ok) return last;
  }
  return last;
}

async function postJsonWithTimeout(url, body, timeoutMs = 8000, extraHeaders = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
    }

    const data = await r.json();
    return { ok: true, data };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `timeout_after_${timeoutMs}ms` : err?.message || String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

function cleanCveId(input) {
  const s0 = (input || '').toString().trim().toUpperCase();
  if (!s0) return null;

  // Accept common variants:
  //  - CVE-2021-12345
  //  - CVE 2021 12345
  //  - CVE2021-12345
  //  - cve_2021_12345
  const s = s0.replace(/_/g, '-');

  const m = s.match(/CVE[- ]?(\d{4})[- ]?(\d{4,7})/);
  return m ? `CVE-${m[1]}-${m[2]}` : null;
}

async function postgrestGet(path, qs, timeoutMs = 6000) {
  const q = qs ? `?${qs}` : '';

  // PostgREST on cold start can transiently 503 with schema-cache errors (PGRST002).
  // Retry a bit longer in that specific case to reduce flaky tool calls.
  const url = `${SITREP_BASE_URL}${path}${q}`;
  const first = await fetchJsonWithRetries(url, 3, timeoutMs);
  if (first?.ok) return first;

  const err = (first?.error || '').toString();
  const looksLikeSchemaCache = /PGRST002|schema cache/i.test(err);
  if (!looksLikeSchemaCache) return first;

  // Two extra attempts with a slightly longer timeout.
  const second = await fetchJsonWithRetries(url, 2, Math.max(timeoutMs, 9000));
  return second || first;
}

async function buildSitrepSnapshot() {
  const now = new Date();
  const sinceWindow = new Date(now.getTime() - SITREP_WINDOW_HOURS * 60 * 60 * 1000);
  const sinceHistory = new Date(now.getTime() - SITREP_HOURLY_HISTORY_HOURS * 60 * 60 * 1000);

  const sinceWindowIso = sinceWindow.toISOString();
  const sinceHistoryIso = sinceHistory.toISOString();

  const endpoints = {
    dailyInsights: `${SITREP_BASE_URL}/number2_daily_insights_latest?select=insights&limit=1`,

    // Full hourly history exists at this endpoint (verified HTTP 200).
    hourlyHistory: `${SITREP_BASE_URL}/number2_hourly_sitreps?select=generated_at,window_start,window_end,report&window_start=gte.${encodeURIComponent(
      sinceHistoryIso,
    )}&order=window_start.desc&limit=${encodeURIComponent(String(SITREP_HOURLY_HISTORY_HOURS))}`,

    // Existing 7d stats view.
    stats7d: `${SITREP_BASE_URL}/stats_severity_by_source_7d?select=source_name,severity_level,cnt`,

    // Cache articles for the past 7 days; the agent will default to the last 24h.
    itemsHistory: `${SITREP_BASE_URL}/analysis_entries_lite?select=analysis_guid,title,link,published,source_name,severity_level,confidence_pct,summary_impact,relevance,analysed_at&analysed_at=gte.${encodeURIComponent(
      sinceHistoryIso,
    )}&order=severity_rank.asc,analysed_at.desc&limit=250`,

    // Extra “front page” slice: newest items in the call window.
    // NOTE: PostgREST only exposes the API schema, so we stick to an existing endpoint.
    itemsRecent: `${SITREP_BASE_URL}/analysis_entries_lite?select=analysis_guid,title,link,published,source_name,severity_level,confidence_pct,summary_impact,relevance,analysed_at&published=gte.${encodeURIComponent(
      sinceWindowIso,
    )}&order=published.desc&limit=120`,
  };

  const [dailyInsightsR, hourlyHistoryR, stats7dR, itemsHistoryR, itemsRecentR] = await Promise.all([
    fetchJsonWithRetries(endpoints.dailyInsights, 3, 5000),
    fetchJsonWithRetries(endpoints.hourlyHistory, 3, 8000),
    fetchJsonWithRetries(endpoints.stats7d, 3, 5000),
    fetchJsonWithRetries(endpoints.itemsHistory, 3, 8000),
    fetchJsonWithRetries(endpoints.itemsRecent, 3, 7000),
  ]);

  const errors = {};
  if (!dailyInsightsR?.ok) errors.dailyInsights = dailyInsightsR?.error || 'unknown_error';
  if (!hourlyHistoryR?.ok) errors.hourlyHistory = hourlyHistoryR?.error || 'unknown_error';
  if (!stats7dR?.ok) errors.stats7d = stats7dR?.error || 'unknown_error';
  if (!itemsHistoryR?.ok) errors.itemsHistory = itemsHistoryR?.error || 'unknown_error';
  if (!itemsRecentR?.ok) errors.itemsRecent = itemsRecentR?.error || 'unknown_error';

  const hourlyHistory = hourlyHistoryR?.ok ? hourlyHistoryR.data || [] : [];
  const hourlyLatest = hourlyHistory.length > 0 ? hourlyHistory[0] : null;

  const itemsHistory = itemsHistoryR?.ok ? itemsHistoryR.data || [] : [];
  const itemsWindow = itemsHistory.filter((e) => {
    const t = e?.analysed_at || e?.published || null;
    if (!t) return false;
    return new Date(t).getTime() >= sinceWindow.getTime();
  });

  const itemsRecent = itemsRecentR?.ok ? itemsRecentR.data || [] : [];

  return {
    fetched_at: new Date().toISOString(),
    endpoints,
    errors: Object.keys(errors).length ? errors : null,

    // cached data
    daily_insights_latest: dailyInsightsR?.ok ? (dailyInsightsR.data?.[0]?.insights ?? null) : null,
    stats_severity_by_source_7d: stats7dR?.ok ? (stats7dR.data ?? []) : [],

    hourly_sitrep_latest: hourlyLatest,
    hourly_sitreps_history: hourlyHistory,

    // Keep the existing field name for compatibility with prompt builder.
    analysis_entries_lite_7d: itemsWindow,

    // Recent, newest-first slice for better “headlines” on call start.
    analysis_entries_lite_recent: itemsRecent,

    // Extra cached history if you want it later.
    analysis_entries_lite_history: itemsHistory,

    window: {
      since_hours: SITREP_WINDOW_HOURS,
      since_iso: sinceWindowIso,
      history_hours: SITREP_HOURLY_HISTORY_HOURS,
      history_since_iso: sinceHistoryIso,
    },
  };
}

async function refreshSitrepCache({ force = false } = {}) {
  const nowMs = Date.now();
  const ageSeconds = (nowMs - (sitrepCache.fetchedAtMs || 0)) / 1000;

  if (!force && sitrepCache.data && ageSeconds < SITREP_REFRESH_SECONDS) {
    return sitrepCache.data;
  }

  if (sitrepCache.refreshInFlight) return sitrepCache.refreshInFlight;

  const p = (async () => {
    try {
      const snapshot = await buildSitrepSnapshot();

      const gotAnyData =
        snapshot.daily_insights_latest ||
        snapshot.hourly_sitrep_latest ||
        (snapshot.stats_severity_by_source_7d && snapshot.stats_severity_by_source_7d.length > 0) ||
        (snapshot.analysis_entries_lite_7d && snapshot.analysis_entries_lite_7d.length > 0) ||
        (snapshot.analysis_entries_lite_recent && snapshot.analysis_entries_lite_recent.length > 0) ||
        (snapshot.hourly_sitreps_history && snapshot.hourly_sitreps_history.length > 0);

      if (!gotAnyData) {
        sitrepCache.lastError = snapshot.errors || {
          all: 'sitrep_unavailable',
        };
        console.warn('[cache][refresh_empty]', {
          errors: sitrepCache.lastError,
        });
        return;
      }

      sitrepCache.fetchedAtMs = Date.now();
      sitrepCache.data = snapshot;
      sitrepCache.lastError = snapshot.errors || null;
      sitrepCache.lastOkAtMs = Date.now();
      sitrepCache.lastOkCounts = {
        hourly_count: snapshot.hourly_sitreps_history?.length || 0,
        items_window_count: snapshot.analysis_entries_lite_7d?.length || 0,
        items_history_count: snapshot.analysis_entries_lite_history?.length || 0,
      };

      console.log('[cache][refresh_ok]', {
        age_seconds: Math.floor(ageSeconds),
        refresh_seconds: SITREP_REFRESH_SECONDS,
        history_hours: SITREP_HOURLY_HISTORY_HOURS,
        hourly_count: snapshot.hourly_sitreps_history?.length || 0,
        items_window_count: snapshot.analysis_entries_lite_7d?.length || 0,
        items_history_count: snapshot.analysis_entries_lite_history?.length || 0,
        errors: snapshot.errors ? Object.keys(snapshot.errors) : null,
      });
    } catch (err) {
      sitrepCache.lastError = { refresh: err?.message || String(err) };
      console.warn('[cache][refresh_error]', sitrepCache.lastError);
    }
  })();

  sitrepCache.refreshInFlight = p;
  try {
    await p;
  } finally {
    sitrepCache.refreshInFlight = null;
  }

  return sitrepCache.data;
}

async function fetchSitrepContext() {
  // Call-time accessor: never do heavy network work on the call path.
  // We serve whatever is in memory and refresh in the background.

  const nowMs = Date.now();
  const ageSeconds = (nowMs - (sitrepCache.fetchedAtMs || 0)) / 1000;

  if (sitrepCache.data) {
    // If stale, kick off a refresh but don't block the call.
    if (ageSeconds >= SITREP_REFRESH_SECONDS) {
      refreshSitrepCache({ force: true }).catch(() => {});
    }

    return {
      ...sitrepCache.data,
      cache: {
        used: true,
        age_seconds: Math.floor(ageSeconds),
        refresh_seconds: SITREP_REFRESH_SECONDS,
        last_error: sitrepCache.lastError,
      },
    };
  }

  // Cold start: wait briefly for the first refresh, but don't hang the call.
  try {
    await Promise.race([refreshSitrepCache({ force: true }), new Promise((r) => setTimeout(r, 1200))]);
  } catch {
    // ignore
  }

  if (sitrepCache.data) {
    const newAgeSeconds = (Date.now() - (sitrepCache.fetchedAtMs || 0)) / 1000;
    return {
      ...sitrepCache.data,
      cache: {
        used: true,
        age_seconds: Math.floor(newAgeSeconds),
        refresh_seconds: SITREP_REFRESH_SECONDS,
        warmed: true,
        last_error: sitrepCache.lastError,
      },
    };
  }

  // Still nothing: empty context.
  return {
    fetched_at: new Date().toISOString(),
    endpoints: {},
    errors: sitrepCache.lastError || { all: 'sitrep_unavailable' },
    daily_insights_latest: null,
    hourly_sitrep_latest: null,
    hourly_sitreps_history: [],
    stats_severity_by_source_7d: [],
    analysis_entries_lite_7d: [],
    analysis_entries_lite_recent: [],
    analysis_entries_lite_history: [],
    window: {
      since_hours: SITREP_WINDOW_HOURS,
      history_hours: SITREP_HOURLY_HISTORY_HOURS,
    },
    cache: {
      used: false,
      empty: true,
      refresh_seconds: SITREP_REFRESH_SECONDS,
      last_error: sitrepCache.lastError,
    },
  };
}

function buildSystemPrompt(agent, sitrep) {
  const briefing = buildBriefingForModel(sitrep);

  const shared = `
Hard constraints (must follow):
- ONLY discuss cybersecurity / threat intel / incident & vulnerability information.
- DO NOT discuss weather, sports, politics, generic tech news, or anything unrelated.
- DO NOT invent or assume facts.
- EPSS is available on request: ONLY mention EPSS if the caller explicitly asks about EPSS.

Tool use:
- If the caller asks about a topic/vendor/campaign and you need more detail, call semantic_search_news.
- If the caller asks about a specific CVE, KEV status, or wants authoritative CVE facts, call cve_detail.
- If the caller asks for KEV updates, call kev_recent.
- Only call epss_latest / epss_movers_24h when EPSS is explicitly requested.
- If a tool returns an argument error (e.g. missing_query / invalid_cve_id), DO NOT retry the same tool call repeatedly.
  Ask the caller for the missing information, then try again once.
`;

  if (agent === 'rizzy') {
    return `You are RIZZY ODIN (ODIN but nephew-friendly). You are a CYBERSECURITY threat intel voice agent.

Persona:
You are an experienced threat-intelligence analyst with a dry sense of humour.
You explain complex or dull material clearly and concisely, occasionally using light wit,
analogy, or understated sarcasm to keep the reader engaged.

Your humour is subtle, professional, and never undermines accuracy.
You remain rigorous about sources, uncertainty, and evidence.
When something is speculative, you say so plainly.
When something is obvious, you are gently amused by it.

You are likeable, not flippant.

Style guide:
- Clear and concise; avoid long monologues.
- Subtle, professional humour only (no snarky dunking, no cringe).
- Keep security content correct.
- Be explicit about uncertainty: say what you know vs what you’re inferring.
- Keep it nephew-friendly (no profanity, no gratuitous gore/violence).
- Speak in short sentences suitable for audio.

${shared}

Conversation style:
- Sound human.
- Ask one short question at a time.
- When you list items, keep it to 3 max, then ask what to zoom in on.

Opening:
- Start with a quick greeting.
- Give 2-3 headlines from the past ${SITREP_WINDOW_HOURS} hours.
- End with: "Want headlines, a vendor search, or a CVE lookup?"

BRIEFING_JSON (filtered cyber-only):\n${JSON.stringify(briefing).slice(0, 12000)}
`;
  }

  return `You are ODIN, a senior SOC master and CYBERSECURITY threat intel voice agent.

Style guide:
- Calm, confident, direct.
- Less procedural. More like a real SOC lead briefing a human.
- Keep responses short and interactive.

${shared}

Conversation style:
- Start with a short greeting.
- Give 2-3 high-signal headlines (not a long monologue).
- Ask what to drill into.
- When you use tool results, cite source + time if present.

BRIEFING_JSON (filtered cyber-only):\n${JSON.stringify(briefing).slice(0, 12000)}
`;
}

function openAiRealtime() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  return new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });
}

function twilioSend(ws, event) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(event));
  } catch (err) {
    console.warn('[twilio][send_error]', {
      event: event?.event,
      message: err?.message || String(err),
    });
  }
}

function openAiSend(ws, event) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(event));
  } catch (err) {
    console.warn('[openai][send_error]', {
      type: event?.type,
      message: err?.message || String(err),
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/healthz')) {
    const ageSeconds = sitrepCache.fetchedAtMs ? Math.floor((Date.now() - sitrepCache.fetchedAtMs) / 1000) : null;

    const data = sitrepCache.data;
    const counts = {
      hourly_count: data?.hourly_sitreps_history?.length || 0,
      items_window_count: data?.analysis_entries_lite_7d?.length || 0,
      items_history_count: data?.analysis_entries_lite_history?.length || 0,
    };

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        cache: {
          has_data: !!sitrepCache.data,
          age_seconds: ageSeconds,
          refresh_seconds: SITREP_REFRESH_SECONDS,
          last_error: sitrepCache.lastError,
          in_flight: !!sitrepCache.refreshInFlight,
          last_ok_age_seconds: sitrepCache.lastOkAtMs ? Math.floor((Date.now() - sitrepCache.lastOkAtMs) / 1000) : null,
          counts,
          window: data?.window || null,
        },
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const remote = req.socket?.remoteAddress;
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname !== '/twilio/stream') {
    console.warn('[twilio][upgrade] reject: bad_path', {
      remote,
      path: url.pathname,
    });
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  const tokenStr = (token || '').toString();

  const tokenMeta = {
    present: !!token,
    len: tokenStr.length,
    dotCount: (tokenStr.match(/\./g) || []).length,
    parts: tokenStr.split('.').length,
    paramKeys: Array.from(url.searchParams.keys()),
  };

  // IMPORTANT: we've observed Twilio connecting with either:
  //  - no `token` querystring, OR
  //  - a malformed/stripped query token (e.g. missing the signature part)
  //
  // To avoid hard-failing calls during the WebSocket upgrade, we allow the
  // upgrade to proceed in those cases and require Twilio to provide a valid
  // token via the Media Stream `start.customParameters` (aka <Stream><Parameter/>).
  if (token) {
    const v = verifyToken(token);
    if (v.ok) {
      console.log('[twilio][upgrade] accept', {
        remote,
        callSid: v.payload?.callSid,
        agent: v.payload?.agent,
      });

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { verified: true, payload: v.payload });
      });
      return;
    }

    console.warn('[twilio][upgrade] accept_without_token_invalid_query_token', {
      remote,
      reason: v.reason,
      tokenMeta,
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { verified: false, payload: null });
    });
    return;
  }

  console.warn('[twilio][upgrade] accept_without_token', { remote, tokenMeta });
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { verified: false, payload: null });
  });
});

wss.on('connection', async (twilioWs, req, auth) => {
  const remote = req.socket?.remoteAddress;

  let openaiWs;
  let streamSid;
  let tokenPayload = auth?.payload || null;

  let openAiReady = false;
  let initialResponseSent = false;

  // Barge-in (interrupt) support:
  // - When caller speech is detected (via OpenAI server_vad events), cancel the
  //   current assistant response and stop forwarding assistant audio.
  let bargeInActive = false;
  let assistantSpeaking = false;

  // When we call response.cancel, OpenAI may reply with `response_cancel_not_active`
  // if there is no active response. Track our intent so we only cancel when it
  // makes sense, reducing noise and avoiding disrupting tool-driven responses.
  let responseIsActive = false;
  let lastCancelAtMs = 0;

  // VAD can be chatty (rapid start/stop), especially on phone lines.
  // Debounce speech-start events so we don't repeatedly clear/suppress audio,
  // which can cause audible chopping.
  const VAD_BARGE_IN_DEBOUNCE_MS = parseInt(process.env.VAD_BARGE_IN_DEBOUNCE_MS || '450', 10);
  let lastSpeechStartedAtMs = 0;

  // If we send a tool output while no response is active, the model may need a
  // gentle `response.create` to resume speaking. Throttle these nudges.
  const TOOL_NUDGE_MIN_INTERVAL_MS = 800;
  let lastToolNudgeAtMs = 0;

  const pendingTwilioToOpenAi = [];

  // Outbound audio pacing (OpenAI -> Twilio).
  // Without pacing, OpenAI can generate audio faster-than-realtime and Twilio will
  // buffer it, making “barge-in” impossible. We drip audio at ~20ms frames.
  const OUT_FRAME_MS = 20;
  const OUT_FRAME_BYTES = 160; // 8kHz * 20ms * 1 byte (g711 ulaw)

  // Allow enough buffer for natural speech without dropping/garbling words.
  // This value is critical: OpenAI can generate audio faster-than-realtime.
  // If it's too small, we will hit backpressure and cut responses mid-sentence.
  // Tune via env to trade off barge-in responsiveness vs uninterrupted playback.
  const OUT_MAX_BUFFER_MS = parseInt(process.env.OUT_MAX_BUFFER_MS || '20000', 10);
  const OUT_MAX_BUFFER_BYTES = Math.floor((OUT_MAX_BUFFER_MS / OUT_FRAME_MS) * OUT_FRAME_BYTES);

  // When OpenAI generates faster-than-realtime, our outbound queue can grow.
  // Instead of cancelling the response (which can lead to silence), we trim
  // the oldest queued audio to keep latency bounded.
  const OUT_TRIM_TARGET_BYTES = Math.floor(OUT_MAX_BUFFER_BYTES * 0.6);
  const OUT_LOW_WATER_BYTES = Math.floor(OUT_MAX_BUFFER_BYTES * 0.4);

  // Small jitter buffer before we start playback to smooth WS/timer jitter.
  // Important: keep this SMALL; if it's too big, short responses may never play.
  const OUT_JITTER_MS = 60;
  const OUT_JITTER_BYTES = Math.floor((OUT_JITTER_MS / OUT_FRAME_MS) * OUT_FRAME_BYTES);

  const outAudioChunks = [];
  let outAudioOffset = 0;
  let outAudioBytes = 0;
  let outSendTimer = null;
  let outBackpressure = false;
  let lastOutTrimLogAtMs = 0;

  // Allow catch-up bursts when our timer is delayed or OpenAI audio arrives
  // in larger chunks, to reduce queue growth (and avoid trimming/drops).
  const OUT_MAX_FRAMES_PER_TICK = parseInt(process.env.OUT_MAX_FRAMES_PER_TICK || '10', 10);

  // Playback state
  let outPlaybackStarted = false;
  let outFirstAudioAtMs = 0;
  let outSuppressUntilMs = 0;
  let lastTwilioClearAtMs = 0;

  // Best-effort: track active OpenAI response id to avoid mixing audio from
  // overlapping responses.
  let activeResponseId = null;

  // ---- Tool calling state (per call) ----
  // TOOL_CALL_LIMIT counts only "real" tool executions (i.e. after argument validation passes).
  const TOOL_CALL_LIMIT = parseInt(process.env.TOOL_CALL_LIMIT || '6', 10);

  // Hard cap (includes invalid-arg tool calls) to prevent infinite loops if the model
  // keeps emitting malformed tool calls with new call_ids.
  const TOOL_CALL_HARD_LIMIT = parseInt(process.env.TOOL_CALL_HARD_LIMIT || '30', 10);

  // If the same tool keeps getting invalid args, stop letting the model spam it.
  const TOOL_ARG_ERROR_LIMIT = parseInt(process.env.TOOL_ARG_ERROR_LIMIT || '3', 10);

  const allowedNewsNodeIds = new Set();

  // Track in-progress tool calls that may arrive as deltas.
  // Canonical key is the call_id we must use when sending function_call_output.
  const toolCallsById = new Map();
  // canonicalCallId -> { name, argsText, startedAtMs, aliasIds:Set<string> }

  // Realtime sometimes references the same function call by different IDs across events:
  // - output_item.added: item.call_id (preferred) and/or item.id
  // - function_call_arguments.delta/done: msg.item_id and/or msg.call_id
  // Maintain an alias map so deltas always attach to the right call.
  const toolCallAliasToCanonical = new Map(); // aliasId -> canonicalCallId

  function normToolId(id) {
    const s = (id || '').toString();
    return s.trim() ? s.trim() : null;
  }

  function ensureToolCallEntry(canonicalCallId) {
    const cid = normToolId(canonicalCallId);
    if (!cid) return null;
    if (!toolCallsById.has(cid)) {
      toolCallsById.set(cid, {
        name: null,
        argsText: '',
        startedAtMs: Date.now(),
        aliasIds: new Set([cid]),
      });
    }
    return toolCallsById.get(cid);
  }

  function linkToolCallIds({ canonicalCallId, aliasIds }) {
    const canonical = normToolId(canonicalCallId);
    if (!canonical) return null;

    // Ensure target (preferred) canonical entry exists.
    const target = ensureToolCallEntry(canonical);
    if (!target) return null;

    // If we already created a placeholder entry under another id (e.g. early deltas
    // keyed by item_id), merge it into the target canonical.
    const list = Array.isArray(aliasIds) ? aliasIds : [];
    const mergeCanonicals = new Set();

    // Any alias may already be mapped to a different canonical.
    for (const a of list) {
      const alias = normToolId(a);
      if (!alias) continue;

      const mapped = toolCallAliasToCanonical.get(alias);
      if (mapped && mapped !== canonical) mergeCanonicals.add(mapped);

      // If we created an entry directly under this alias, merge it as well.
      if (toolCallsById.has(alias) && alias !== canonical) mergeCanonicals.add(alias);
    }

    for (const otherCanonical of mergeCanonicals) {
      const other = toolCallsById.get(otherCanonical);
      if (!other) continue;

      // Merge args preserving approximate time ordering.
      const tArgs = target.argsText || '';
      const oArgs = other.argsText || '';
      if (oArgs) {
        if ((other.startedAtMs || 0) < (target.startedAtMs || 0)) {
          target.argsText = oArgs + tArgs;
          target.startedAtMs = Math.min(target.startedAtMs || Date.now(), other.startedAtMs || Date.now());
        } else {
          target.argsText = tArgs + oArgs;
        }
      }

      // Prefer an explicit name if target didn't have one yet.
      if (!target.name && other.name) target.name = other.name;

      // Merge aliases.
      for (const a of other.aliasIds || []) target.aliasIds.add(a);
      target.aliasIds.add(otherCanonical);

      // Re-point alias mappings.
      for (const a of other.aliasIds || []) toolCallAliasToCanonical.set(a, canonical);
      toolCallAliasToCanonical.set(otherCanonical, canonical);

      toolCallsById.delete(otherCanonical);
    }

    // Now record the provided aliases.
    for (const a of list) {
      const alias = normToolId(a);
      if (!alias) continue;
      toolCallAliasToCanonical.set(alias, canonical);
      target.aliasIds.add(alias);
    }

    // Also ensure canonical is mapped to itself.
    toolCallAliasToCanonical.set(canonical, canonical);
    target.aliasIds.add(canonical);

    toolCallsById.set(canonical, target);
    return canonical;
  }

  function resolveCanonicalToolCallId(id) {
    const key = normToolId(id);
    if (!key) return null;
    return toolCallAliasToCanonical.get(key) || key;
  }

  // Budgets + dedupe to avoid multiple event-shape handlers executing the same call twice.
  let toolCallsExecuted = 0;
  let toolCallsTotalSeen = 0;
  const toolCallsExecutedIds = new Set();

  const toolArgErrorCountsByName = new Map(); // name -> count

  // Serialize tool executions to avoid races with budgets + logs.
  let toolExecChain = Promise.resolve();
  function enqueueToolExecution(fn) {
    toolExecChain = toolExecChain.then(fn).catch(() => {});
  }

  function isArgumentErrorCode(code) {
    return ['missing_query', 'invalid_cve_id', 'missing_node_id', 'node_id_not_allowed', 'bad_arguments_json'].includes(
      code,
    );
  }

  function bumpArgError(name, code) {
    if (!name) return 0;
    const cur = toolArgErrorCountsByName.get(name) || 0;
    const next = cur + 1;
    toolArgErrorCountsByName.set(name, next);

    if (TOOL_LOG_LEVEL !== 'none') {
      console.warn('[openai][tool_arg_error]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        name,
        code,
        count: next,
        limit: TOOL_ARG_ERROR_LIMIT,
      });
    }

    return next;
  }

  function toolArgGuidance(name, code) {
    if (code === 'missing_query') {
      return 'Ask the caller for a search query string (vendor/product/campaign). Do not call semantic_search_news again until you have it.';
    }
    if (code === 'invalid_cve_id') {
      return 'Ask the caller for a CVE identifier (e.g. CVE-2024-12345). Do not retry cve_detail until you have a valid CVE.';
    }
    if (code === 'missing_node_id') {
      return 'Ask which result they want (node id) or repeat semantic_search_news first.';
    }
    if (code === 'node_id_not_allowed') {
      return 'That node_id was not returned by a prior semantic_search_news call in this conversation. Ask the caller which returned result to drill into.';
    }
    if (code === 'bad_arguments_json') {
      return 'Your tool arguments were not valid JSON. Call the tool again with a proper JSON object matching the schema.';
    }
    return null;
  }

  function safeJsonParse(s) {
    // Realtime sometimes delivers function arguments as:
    // - a JSON string
    // - an already-parsed object
    // - null/empty
    if (s && typeof s === 'object') return { ok: true, value: s };
    if (s === null || s === undefined) return { ok: true, value: {} };

    const text = (s || '').toString();
    if (!text.trim()) return { ok: true, value: {} };

    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      // Best-effort salvage: Realtime argument streams can sometimes end up with
      // extra prefixes/suffixes or duplicated fragments. Try to extract a single
      // JSON object/array substring.
      const t = text.trim();
      const objStart = t.indexOf('{');
      const objEnd = t.lastIndexOf('}');
      if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
        try {
          return { ok: true, value: JSON.parse(t.slice(objStart, objEnd + 1)) };
        } catch {
          // continue
        }
      }

      const arrStart = t.indexOf('[');
      const arrEnd = t.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
        try {
          return { ok: true, value: JSON.parse(t.slice(arrStart, arrEnd + 1)) };
        } catch {
          // continue
        }
      }

      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function tool_semantic_search_news(args) {
    // The tool schema uses `query`, but the model sometimes emits `text` or `q`.
    const query = (args?.query || args?.text || args?.q || '').toString().trim();
    const nResults = Math.max(1, Math.min(15, parseInt(args?.n_results ?? 10, 10) || 10));
    if (!query) return { ok: false, error: 'missing_query' };

    const url = `${CYBERSCAPE_NEXUS_BASE_URL}/api/v1/search`;
    const r = await postJsonWithTimeout(url, { text: query, n_results: nResults }, 12000);
    if (!r.ok) return { ok: false, error: r.error };

    const results = Array.isArray(r.data?.results) ? r.data.results : [];

    // Allow node drill-down only for node ids returned in this call.
    for (const it of results) {
      if (it?.id) allowedNewsNodeIds.add(String(it.id));
    }

    return {
      ok: true,
      query: r.data?.query || query,
      count: r.data?.count ?? results.length,
      results: results.slice(0, nResults).map((it) => ({
        id: it?.id,
        score: it?.score,
        title: it?.title,
        url: it?.url,
        source: it?.source,
        published: it?.published,
        severity: it?.severity,
        summary_impact: it?.summary_impact,
      })),
    };
  }

  async function tool_get_news_node(args) {
    const nodeId = (args?.node_id || '').toString().trim();
    if (!nodeId) return { ok: false, error: 'missing_node_id' };
    if (!allowedNewsNodeIds.has(nodeId)) return { ok: false, error: 'node_id_not_allowed' };

    const url = `${CYBERSCAPE_NEXUS_BASE_URL}/api/v1/node/${encodeURIComponent(nodeId)}`;
    const r = await fetchWithTimeout(url, 12000);
    if (!r.ok) return { ok: false, error: r.error };

    // Return a compact subset; the model can ask for more.
    const data = r.data || {};
    return { ok: true, node_id: nodeId, data };
  }

  async function tool_cve_detail(args) {
    // The tool schema uses `cve_id`, but be tolerant of `cve`/`id` too.
    const cveId = cleanCveId(args?.cve_id || args?.cve || args?.id);
    if (!cveId) return { ok: false, error: 'invalid_cve_id' };

    // Use the joined view if available.
    const qs = `select=cve_id,cvss_base,description_en,modified,epss,epss_percentile,epss_as_of,in_kev,date_added,due_date,vendor,product,vulnerability_name,required_action,known_ransomware_campaign_use,mention_count,last_seen&cve_id=eq.${encodeURIComponent(
      cveId,
    )}&limit=1`;

    const r = await postgrestGet('/cve_detail', qs, 8000);
    if (!r.ok) return { ok: false, error: r.error };

    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (!row) return { ok: false, error: 'not_found' };

    return { ok: true, cve: row };
  }

  async function tool_kev_recent(args) {
    const sinceDays = Math.max(1, Math.min(30, parseInt(args?.since_days ?? 7, 10) || 7));
    const limit = Math.max(1, Math.min(50, parseInt(args?.limit ?? 10, 10) || 10));
    const vendor = args?.vendor ? String(args.vendor).trim() : null;

    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const sinceIsoDate = since.toISOString().slice(0, 10);

    const filters = [`date_added=gte.${encodeURIComponent(sinceIsoDate)}`];
    if (vendor) filters.push(`vendor=ilike.*${encodeURIComponent(vendor)}*`);

    const qs = `select=cve_id,date_added,due_date,vendor,product,vulnerability_name,short_description,required_action,known_ransomware_campaign_use&${filters.join(
      '&',
    )}&order=date_added.desc&limit=${encodeURIComponent(String(limit))}`;

    const r = await postgrestGet('/kev_cves_lite', qs, 8000);
    if (!r.ok) return { ok: false, error: r.error };

    const rows = Array.isArray(r.data) ? r.data : [];
    return {
      ok: true,
      since_days: sinceDays,
      vendor,
      count: rows.length,
      results: rows,
    };
  }

  async function tool_epss_latest(args) {
    const cveId = cleanCveId(args?.cve_id || args?.cve || args?.id);
    if (!cveId) return { ok: false, error: 'invalid_cve_id' };

    const qs = `select=cve_id,as_of,epss,percentile&cve_id=eq.${encodeURIComponent(cveId)}&order=as_of.desc&limit=1`;

    // EPSS endpoints can be slower than the rest; give them a bit more time.
    const r = await postgrestGet('/epss_latest', qs, 12000);
    if (!r.ok) return { ok: false, error: r.error };

    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (!row) return { ok: false, error: 'not_found' };

    return { ok: true, epss: row };
  }

  async function tool_epss_movers_24h(args) {
    const limit = Math.max(1, Math.min(50, parseInt(args?.limit ?? 10, 10) || 10));
    const qs = `select=cve_id,epss_today,epss_yday,delta,percentile_today,percentile_yday&order=delta.desc&limit=${encodeURIComponent(
      String(limit),
    )}`;

    // EPSS endpoints can be slower than the rest; give them a bit more time.
    const r = await postgrestGet('/epss_movers_24h', qs, 12000);
    if (!r.ok) return { ok: false, error: r.error };

    const rows = Array.isArray(r.data) ? r.data : [];
    return { ok: true, count: rows.length, results: rows };
  }

  async function executeToolByName(name, args) {
    switch (name) {
      case 'semantic_search_news':
        return tool_semantic_search_news(args);
      case 'get_news_node':
        return tool_get_news_node(args);
      case 'cve_detail':
        return tool_cve_detail(args);
      case 'kev_recent':
        return tool_kev_recent(args);
      case 'epss_latest':
        return tool_epss_latest(args);
      case 'epss_movers_24h':
        return tool_epss_movers_24h(args);
      default:
        return { ok: false, error: `unknown_tool:${name}` };
    }
  }

  function sendToolOutput(callId, outputObj) {
    // Realtime tool calling: provide the output as a conversation item.
    // Important: do NOT create a new response here; the tool output should
    // allow the model to continue the currently active response.

    const outputText = JSON.stringify(outputObj);

    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.warn('[openai][tool_output_drop]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        callId,
        reason: 'openai_ws_not_open',
      });
      return;
    }

    openAiSend(openaiWs, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: outputText,
      },
    });

    if (TOOL_LOG_LEVEL === 'all') {
      console.log('[openai][tool_output_sent]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        callId,
        bytes: Buffer.byteLength(outputText, 'utf8'),
      });
    }

    // If there's no active response (e.g. due to barge-in/backpressure cancel),
    // prompt the model to continue after receiving the tool output.
    const now = Date.now();
    if (!responseIsActive && now - lastToolNudgeAtMs > TOOL_NUDGE_MIN_INTERVAL_MS) {
      lastToolNudgeAtMs = now;
      setTimeout(() => {
        if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
        if (responseIsActive) return;

        openAiSend(openaiWs, {
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
          },
        });

        if (TOOL_LOG_LEVEL === 'all') {
          console.log('[openai][tool_nudge_response_create]', {
            callSid: tokenPayload?.callSid,
            agent: tokenPayload?.agent,
            callId,
          });
        }
      }, 80);
    }
  }

  async function handleToolCall(callId, name, argsText) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    const cid = (callId || '').toString();
    if (!cid) return;

    // Dedupe: multiple event types can represent the same function call.
    if (toolCallsExecutedIds.has(cid)) return;

    toolCallsTotalSeen += 1;

    // Hard cap: stop infinite loops even if the model changes call_id each time.
    if (toolCallsTotalSeen > TOOL_CALL_HARD_LIMIT) {
      toolCallsExecutedIds.add(cid);
      sendToolOutput(cid, {
        ok: false,
        error: 'tool_call_hard_limit_reached',
        guidance: 'Stop calling tools. Ask the caller what they want and respond without tools.',
      });
      return;
    }

    // If a specific tool keeps failing due to argument issues, stop letting the model spam it.
    const priorArgErrors = toolArgErrorCountsByName.get(name) || 0;
    if (priorArgErrors >= TOOL_ARG_ERROR_LIMIT) {
      toolCallsExecutedIds.add(cid);
      sendToolOutput(cid, {
        ok: false,
        error: 'tool_arg_error_limit_reached',
        tool: name,
        guidance: 'Stop retrying this tool. Ask the caller for the missing info.',
      });
      return;
    }

    const parsed = safeJsonParse(argsText || '{}');
    if (!parsed.ok) {
      toolCallsExecutedIds.add(cid);
      const code = 'bad_arguments_json';
      const count = bumpArgError(name, code);

      sendToolOutput(cid, {
        ok: false,
        error: code,
        parse_error: parsed.error,
        guidance: toolArgGuidance(name, code),
        arg_error_count: count,
      });
      return;
    }

    const args = parsed.value || {};

    // Helpful for debugging: confirm which argument keys the model actually sent.
    const argKeys = args && typeof args === 'object' ? Object.keys(args).slice(0, 12) : [];

    if (TOOL_LOG_LEVEL === 'all') {
      console.log('[openai][tool_call]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        callId: cid,
        name,
        args_parse_ok: parsed.ok,
        args_keys: argKeys,
        args_len: typeof argsText === 'string' ? argsText.length : null,
      });
    }

    // Execute tool.
    const startedAtMs = Date.now();

    let result;
    try {
      result = await executeToolByName(name, args);
    } catch (err) {
      result = { ok: false, error: `exception:${err?.message || String(err)}` };
    }

    const durationMs = Date.now() - startedAtMs;

    // If the tool failed due to missing/invalid args, DO NOT count it against TOOL_CALL_LIMIT.
    if (isArgumentErrorCode(result?.error)) {
      const count = bumpArgError(name, result.error);
      toolCallsExecutedIds.add(cid);

      const guidance = toolArgGuidance(name, result.error);
      sendToolOutput(cid, { ...result, guidance, arg_error_count: count });

      if (TOOL_LOG_LEVEL === 'all' || TOOL_LOG_LEVEL === 'errors') {
        console.log('[openai][tool_result]', {
          callSid: tokenPayload?.callSid,
          agent: tokenPayload?.agent,
          callId: cid,
          name,
          ok: false,
          error: result?.error,
          duration_ms: durationMs,
          counted: false,
        });
      }

      return;
    }

    if (toolCallsExecuted >= TOOL_CALL_LIMIT) {
      // This call is already "seen" but we haven't executed it; respond with limit reached.
      toolCallsExecutedIds.add(cid);
      sendToolOutput(cid, { ok: false, error: 'tool_call_limit_reached' });
      return;
    }

    toolCallsExecuted += 1;
    toolCallsExecutedIds.add(cid);

    if (TOOL_LOG_LEVEL === 'all' || (TOOL_LOG_LEVEL === 'errors' && !result?.ok)) {
      console.log('[openai][tool_result]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        callId: cid,
        name,
        ok: !!result?.ok,
        error: result?.ok ? null : result?.error || 'unknown_error',
        duration_ms: durationMs,
        counted: true,
      });
    }

    sendToolOutput(cid, result);
  }

  function queueTwilioToOpenAi(payload) {
    pendingTwilioToOpenAi.push(payload);
  }

  function flushTwilioToOpenAi() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    while (pendingTwilioToOpenAi.length > 0) {
      const payload = pendingTwilioToOpenAi.shift();
      openAiSend(openaiWs, {
        type: 'input_audio_buffer.append',
        audio: payload,
      });
    }
  }

  function clearOutAudio(reason) {
    const bytesBefore = outAudioBytes;
    if (bytesBefore > 0) {
      console.log('[bridge][out_audio] clear', { reason, bytes: bytesBefore });
    }

    outAudioChunks.length = 0;
    outAudioOffset = 0;
    outAudioBytes = 0;
    outBackpressure = false;
    outPlaybackStarted = false;
    outFirstAudioAtMs = 0;

    // Ask Twilio to flush any buffered audio (best-effort; ignored if unsupported).
    // Throttle to avoid spamming clear events, which can produce audible artifacts.
    const now = Date.now();
    const forceClear = reason.startsWith('twilio_ws_');
    const shouldClear =
      !!streamSid &&
      (forceClear || assistantSpeaking || bytesBefore >= OUT_FRAME_BYTES) &&
      now - lastTwilioClearAtMs > 800;

    if (shouldClear) {
      lastTwilioClearAtMs = now;
      twilioSend(twilioWs, { event: 'clear', streamSid });
    }

    assistantSpeaking = false;
  }

  function trimOutAudioToTargetBytes(targetBytes) {
    const target = Math.max(0, Math.floor(targetBytes || 0));
    if (outAudioBytes <= target) return { droppedBytes: 0, droppedChunks: 0 };

    let toDrop = outAudioBytes - target;
    let droppedBytes = 0;
    let droppedChunks = 0;

    while (toDrop > 0 && outAudioChunks.length > 0) {
      const first = outAudioChunks[0];
      const available = first.length - outAudioOffset;
      if (available <= 0) {
        outAudioChunks.shift();
        outAudioOffset = 0;
        droppedChunks += 1;
        continue;
      }

      if (toDrop < available) {
        outAudioOffset += toDrop;
        outAudioBytes -= toDrop;
        droppedBytes += toDrop;
        toDrop = 0;
        break;
      }

      outAudioChunks.shift();
      outAudioOffset = 0;
      outAudioBytes -= available;
      droppedBytes += available;
      droppedChunks += 1;
      toDrop -= available;
    }

    return { droppedBytes, droppedChunks };
  }

  function popOutFrame() {
    if (outAudioBytes === 0) return null;

    // Twilio expects fixed-size g711_ulaw frames. If we have a partial tail,
    // pad with µ-law silence (0xFF) so we don't get "stuck".
    const toRead = Math.min(outAudioBytes, OUT_FRAME_BYTES);
    const out = Buffer.alloc(OUT_FRAME_BYTES, 0xff);

    let written = 0;

    while (written < toRead && outAudioChunks.length > 0) {
      const chunk = outAudioChunks[0];
      const available = chunk.length - outAudioOffset;
      const toCopy = Math.min(available, toRead - written);

      chunk.copy(out, written, outAudioOffset, outAudioOffset + toCopy);
      written += toCopy;
      outAudioOffset += toCopy;

      if (outAudioOffset >= chunk.length) {
        outAudioChunks.shift();
        outAudioOffset = 0;
      }
    }

    outAudioBytes -= toRead;
    if (outAudioBytes === 0) {
      outPlaybackStarted = false;
      outFirstAudioAtMs = 0;
    }

    return out;
  }

  function startOutSendLoop() {
    if (outSendTimer) return;

    let lastTickMs = Date.now();

    outSendTimer = setInterval(() => {
      if (!streamSid) return;
      // Only pause playback on caller speech if we actually have assistant audio
      // to interrupt. This reduces choppy behavior on noisy VAD lines.
      if (bargeInActive && (assistantSpeaking || outAudioBytes > 0)) return;
      if (Date.now() < outSuppressUntilMs) return;

      // Jitter buffer: only gate the *start* of playback.
      if (!outPlaybackStarted && outAudioBytes > 0) {
        const waitedMs = outFirstAudioAtMs ? Date.now() - outFirstAudioAtMs : OUT_JITTER_MS;
        if (outAudioBytes < OUT_JITTER_BYTES && waitedMs < OUT_JITTER_MS) return;
      }

      const now = Date.now();
      const elapsedMs = Math.max(0, now - lastTickMs);
      lastTickMs = now;

      // Send frames corresponding to elapsed time. This keeps the average rate
      // close to real-time, while allowing small catch-up bursts if the timer
      // is delayed.
      const baseFrames = Math.max(1, Math.floor(elapsedMs / OUT_FRAME_MS) || 1);
      let framesToSend = Math.min(3, baseFrames);

      // If OpenAI generates faster-than-realtime, the queue can grow even when
      // our timer is perfectly on-time. When we detect backpressure, temporarily
      // send larger bursts to catch up and avoid trimming/dropping audio.
      if (outBackpressure) {
        framesToSend = Math.min(Math.max(1, OUT_MAX_FRAMES_PER_TICK), Math.max(framesToSend, 6));
      }

      for (let i = 0; i < framesToSend; i += 1) {
        const frame = popOutFrame();
        if (!frame) {
          assistantSpeaking = false;
          outPlaybackStarted = false;
          outFirstAudioAtMs = 0;
          return;
        }

        outPlaybackStarted = true;
        assistantSpeaking = true;
        twilioSend(twilioWs, {
          event: 'media',
          streamSid,
          media: { payload: frame.toString('base64') },
        });
      }

      // Release backpressure once we've drained to a reasonable level.
      if (outBackpressure && outAudioBytes < OUT_LOW_WATER_BYTES) {
        outBackpressure = false;
      }
    }, OUT_FRAME_MS);
  }

  function stopOutSendLoop() {
    if (!outSendTimer) return;
    clearInterval(outSendTimer);
    outSendTimer = null;
  }

  function enqueueOutAudio(deltaB64) {
    if (!deltaB64) return;

    // OpenAI sends standard base64. Be tolerant of url-safe base64 too.
    const normalized = deltaB64.toString().replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    if (!buf.length) return;

    if (outAudioBytes === 0) {
      outFirstAudioAtMs = Date.now();
    }

    outAudioChunks.push(buf);
    outAudioBytes += buf.length;

    if (outAudioBytes > OUT_MAX_BUFFER_BYTES) {
      outBackpressure = true;

      const before = outAudioBytes;
      const { droppedBytes, droppedChunks } = trimOutAudioToTargetBytes(OUT_TRIM_TARGET_BYTES);

      const now = Date.now();
      if (now - lastOutTrimLogAtMs > 1500) {
        lastOutTrimLogAtMs = now;
        console.warn('[bridge][out_audio] buffer_high_trim_audio', {
          bytes_before: before,
          bytes_after: outAudioBytes,
          max_bytes: OUT_MAX_BUFFER_BYTES,
          target_bytes: OUT_TRIM_TARGET_BYTES,
          dropped_bytes: droppedBytes,
          dropped_chunks: droppedChunks,
        });
      }
    }

    startOutSendLoop();
  }

  function cancelAssistant(reason) {
    const now = Date.now();
    if (now - lastCancelAtMs < 350) return;
    lastCancelAtMs = now;

    if (assistantSpeaking || outAudioBytes > 0) {
      console.log('[bridge][barge_in] cancel_assistant', { reason });
    }

    activeResponseId = null;
    outSuppressUntilMs = now + 250;

    // Locally clear any queued audio (this is the most important part).
    clearOutAudio(reason);

    // Best-effort request to stop generation server-side.
    // Only send cancel if we believe a response is active; otherwise it creates
    // log noise and can interfere with tool-driven turns.
    if (responseIsActive && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openAiSend(openaiWs, { type: 'response.cancel' });
    }
  }

  function maybeSendInitialResponse() {
    if (!openAiReady) return;
    if (!streamSid) return;
    if (initialResponseSent) return;

    initialResponseSent = true;
    openAiSend(openaiWs, {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: `Open with a short greeting and deliver a concise (<= 25 seconds) CYBER THREAT SITREP for the past ${SITREP_WINDOW_HOURS} hours. Give 2-3 headlines max, then ask what they want to drill into (headlines vs vendor search vs CVE lookup). Stay cyber-only. If threat intel data is missing, say so explicitly.`,
      },
    });
  }

  async function startOpenAiSession() {
    if (openaiWs) return; // already started
    if (!tokenPayload) return;

    const sitrep = await fetchSitrepContext();
    const agent = tokenPayload?.agent || 'odin';
    const systemPrompt = buildSystemPrompt(agent, sitrep);

    const briefing = buildBriefingForModel(sitrep);
    console.log('[bridge][briefing]', {
      callSid: tokenPayload?.callSid,
      agent,
      errors: briefing?.errors ? Object.keys(briefing.errors) : null,
      notable_entries_7d: Array.isArray(briefing?.notable_entries_7d) ? briefing.notable_entries_7d.length : 0,
      non_cyber_entries_filtered_out: briefing?.non_cyber_entries_filtered_out ?? null,
      cache: briefing?.cache || null,
    });

    openaiWs = openAiRealtime();

    openaiWs.on('open', () => {
      openAiReady = true;
      console.log('[openai][ws_open]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        model: OPENAI_REALTIME_MODEL,
      });

      openAiSend(openaiWs, {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: systemPrompt,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: OPENAI_VOICE,
          turn_detection: { type: 'server_vad' },

          // Tool calling (natural-language → approved API calls).
          // We keep this list small and strongly scoped to cyber intel.
          tools: [
            {
              type: 'function',
              name: 'semantic_search_news',
              description:
                'Semantic search across recent cybersecurity news/articles. Use when the caller asks about a topic, vendor, product, campaign, malware, or incident and you need the most relevant recent articles.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query in plain English.',
                  },
                  n_results: {
                    type: 'integer',
                    description: 'How many results to return (1-15).',
                    minimum: 1,
                    maximum: 15,
                  },
                },
                required: ['query'],
              },
            },
            {
              type: 'function',
              name: 'get_news_node',
              description:
                'Fetch full details for a specific news/intel node previously returned by semantic_search_news. Use for drill-down when the caller asks for details on one result.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  node_id: {
                    type: 'string',
                    description: 'Node ID returned in a prior semantic_search_news result.',
                  },
                },
                required: ['node_id'],
              },
            },
            {
              type: 'function',
              name: 'cve_detail',
              description:
                'Look up a CVE in the local database and return NVD+KEV+EPSS-enriched details. Use when the caller gives a CVE ID or asks if something is in KEV.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  cve_id: {
                    type: 'string',
                    description: 'CVE identifier, e.g. CVE-2024-12345.',
                  },
                },
                required: ['cve_id'],
              },
            },
            {
              type: 'function',
              name: 'kev_recent',
              description:
                'List CISA KEV items added recently (from local database). Use when the caller asks for KEV updates. Do not mention EPSS unless explicitly asked.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  since_days: {
                    type: 'integer',
                    description: 'How many days back to look (1-30).',
                    minimum: 1,
                    maximum: 30,
                  },
                  vendor: {
                    type: 'string',
                    description: 'Optional vendor filter (e.g. Microsoft, Cisco).',
                    nullable: true,
                  },
                  limit: {
                    type: 'integer',
                    description: 'Max results (1-50).',
                    minimum: 1,
                    maximum: 50,
                  },
                },
                required: ['since_days'],
              },
            },
            {
              type: 'function',
              name: 'epss_latest',
              description:
                'Look up latest EPSS score for a given CVE (from local database). ONLY use if the caller explicitly asks about EPSS.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  cve_id: { type: 'string', description: 'CVE identifier.' },
                },
                required: ['cve_id'],
              },
            },
            {
              type: 'function',
              name: 'epss_movers_24h',
              description:
                'List top EPSS movers in the last 24 hours (from local database). ONLY use if the caller explicitly asks about EPSS movers.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  limit: {
                    type: 'integer',
                    description: 'Max results (1-50).',
                    minimum: 1,
                    maximum: 50,
                  },
                },
                required: [],
              },
            },
          ],
        },
      });

      flushTwilioToOpenAi();
      maybeSendInitialResponse();
    });

    openaiWs.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      // OpenAI server-side VAD events. When the caller starts speaking, we want
      // to cancel any ongoing assistant audio (“barge in”).
      if (msg.type === 'input_audio_buffer.speech_started') {
        const now = Date.now();
        if (now - lastSpeechStartedAtMs < VAD_BARGE_IN_DEBOUNCE_MS) return;
        lastSpeechStartedAtMs = now;

        bargeInActive = true;
        console.log('[openai][speech_started]', {
          callSid: tokenPayload?.callSid,
          agent: tokenPayload?.agent,
        });

        // Only cancel/clear if we actually have assistant output in flight.
        // Avoid clearing/suppressing on false-positive VAD starts.
        if (assistantSpeaking || outAudioBytes > 0 || responseIsActive) {
          cancelAssistant('caller_speech_started');
        }
        return;
      }

      if (msg.type === 'input_audio_buffer.speech_stopped') {
        bargeInActive = false;
        console.log('[openai][speech_stopped]', {
          callSid: tokenPayload?.callSid,
          agent: tokenPayload?.agent,
        });

        // Do NOT force response.create here.
        // OpenAI server_vad typically auto-creates a response on end-of-speech.
        // Forcing it can cause `conversation_already_has_active_response`.
        return;
      }

      // ---- Tool call events (OpenAI Realtime) ----
      // We support a couple of possible event shapes since Realtime has evolved.
      // The common pattern is:
      //  - response.output_item.added (item.type=function_call)
      //  - response.function_call_arguments.delta
      //  - response.function_call_arguments.done
      // Alternatively, the completed function_call may appear in output_item.done.

      function logToolEventIds(label, extra = {}) {
        if (TOOL_EVENT_LOG_LEVEL === 'none') return;
        const base = {
          callSid: tokenPayload?.callSid,
          agent: tokenPayload?.agent,
          label,
          type: msg?.type,
          call_id: msg?.call_id ?? msg?.item?.call_id ?? null,
          item_id: msg?.item_id ?? null,
          msg_id: msg?.id ?? null,
          item_id2: msg?.item?.id ?? null,
          name: msg?.name ?? msg?.item?.name ?? null,
          delta_len: typeof msg?.delta === 'string' ? msg.delta.length : null,
          args_len: typeof msg?.item?.arguments === 'string' ? msg.item.arguments.length : null,
          ...extra,
        };

        if (TOOL_EVENT_LOG_LEVEL === 'verbose') {
          const deltaPrefix = (msg?.delta || '').toString().slice(0, 140);
          const argsPrefix = (msg?.item?.arguments || '').toString().slice(0, 140);
          console.log('[openai][tool_event]', {
            ...base,
            delta_prefix: deltaPrefix,
            args_prefix: argsPrefix,
          });
        } else {
          console.log('[openai][tool_event]', base);
        }
      }

      if (msg.type === 'response.output_item.added' && msg?.item?.type === 'function_call') {
        const callId = msg.item?.call_id || null;
        const itemId = msg.item?.id || null;
        const name = msg.item?.name || null;
        const argsText = msg.item?.arguments || '';

        // Canonical must be call_id if present; else fall back to item.id.
        const canonical = linkToolCallIds({
          canonicalCallId: callId || itemId,
          aliasIds: [callId, itemId],
        });
        logToolEventIds('output_item.added', { canonical });

        if (canonical) {
          const entry = ensureToolCallEntry(canonical);
          if (entry) {
            entry.name = name || entry.name;
            if (argsText) {
              const trimmed = argsText.toString().trim();
              const looksCompleteJson =
                (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));

              // Avoid corrupting JSON by concatenating a complete arguments payload
              // onto already-accumulated deltas. Prefer the complete payload.
              if (looksCompleteJson) {
                entry.argsText = trimmed;
              } else {
                entry.argsText = (entry.argsText || '') + argsText;
              }
            }
            toolCallsById.set(canonical, entry);
          }
        }
      }

      if (msg.type === 'response.function_call_arguments.delta') {
        // Some Realtime event shapes provide both a call_id and an item_id.
        // Link them early so deltas always accrue under the correct canonical call_id.
        if (msg.call_id && (msg.item_id || msg.id)) {
          linkToolCallIds({
            canonicalCallId: msg.call_id,
            aliasIds: [msg.call_id, msg.item_id, msg.id],
          });
        }

        const rawId = msg.call_id || msg.item_id || msg.id;
        const canonical = resolveCanonicalToolCallId(rawId);
        const delta = msg.delta || '';

        // Deltas can arrive before output_item.added; preserve them.
        if (canonical && delta) {
          const entry = ensureToolCallEntry(canonical);
          if (entry) {
            entry.argsText = (entry.argsText || '') + delta;
            toolCallsById.set(canonical, entry);
          }
        }

        // If we still can't resolve, at least log it.
        logToolEventIds('arguments.delta', {
          raw_id: rawId,
          canonical,
          preserved: !!(canonical && delta),
        });
      }

      if (msg.type === 'response.function_call_arguments.done') {
        // Same as delta: ensure any item_id/id aliases are linked to call_id.
        if (msg.call_id && (msg.item_id || msg.id)) {
          linkToolCallIds({
            canonicalCallId: msg.call_id,
            aliasIds: [msg.call_id, msg.item_id, msg.id],
          });
        }

        const rawId = msg.call_id || msg.item_id || msg.id;
        const canonical = resolveCanonicalToolCallId(rawId);
        logToolEventIds('arguments.done', { raw_id: rawId, canonical });

        if (!canonical) return;

        const cur = toolCallsById.get(canonical) || null;
        if (cur) toolCallsById.delete(canonical);

        // Clean up aliases for this call.
        const aliasIds = new Set([
          ...(cur?.aliasIds || []),
          msg.call_id,
          msg.item_id,
          msg.id,
          canonical,
        ]);
        for (const a of aliasIds) {
          const key = normToolId(a);
          if (!key) continue;
          toolCallAliasToCanonical.delete(key);
        }

        // If name never arrived (rare), use whatever the msg carried.
        const name = cur?.name || msg?.name || msg?.item?.name || null;
        if (!name) return;

        const argsText = cur?.argsText || '';
        enqueueToolExecution(() => handleToolCall(canonical, name, argsText));
      }

      if (msg.type === 'response.output_item.done' && msg?.item?.type === 'function_call') {
        const callId = msg.item?.call_id || null;
        const itemId = msg.item?.id || null;
        const name = msg.item?.name || null;
        const argsTextFromItem = msg.item?.arguments || '';

        const canonical = linkToolCallIds({
          canonicalCallId: callId || itemId,
          aliasIds: [callId, itemId],
        });
        const entry = canonical ? toolCallsById.get(canonical) : null;
        const argsText = argsTextFromItem || entry?.argsText || '';

        logToolEventIds('output_item.done', {
          canonical,
          used_accumulated_args: !argsTextFromItem && !!entry?.argsText,
          final_args_len: typeof argsText === 'string' ? argsText.length : null,
        });

        if (canonical && name) {
          // Best-effort cleanup now that we're executing.
          if (entry) {
            toolCallsById.delete(canonical);
            for (const a of entry?.aliasIds || []) toolCallAliasToCanonical.delete(a);
          }

          enqueueToolExecution(() => handleToolCall(canonical, name, argsText));
        }
      }

      if (msg.type === 'conversation.item.created' && msg?.item?.type === 'function_call') {
        const callId = msg.item?.call_id || null;
        const itemId = msg.item?.id || null;
        const name = msg.item?.name || null;
        const argsTextFromItem = msg.item?.arguments || '';

        const canonical = linkToolCallIds({
          canonicalCallId: callId || itemId,
          aliasIds: [callId, itemId],
        });
        const entry = canonical ? toolCallsById.get(canonical) : null;
        const argsText = argsTextFromItem || entry?.argsText || '';

        logToolEventIds('conversation.item.created', {
          canonical,
          used_accumulated_args: !argsTextFromItem && !!entry?.argsText,
          final_args_len: typeof argsText === 'string' ? argsText.length : null,
        });

        // IMPORTANT: Do NOT execute tool calls on conversation.item.created.
        // In production logs, this event can arrive before arguments are fully
        // streamed (arguments.delta/done), causing empty-arg executions.
        // We only use this event to learn/merge IDs + preserve name/args.
        if (canonical) {
          const cur = ensureToolCallEntry(canonical);
          if (cur) {
            cur.name = name || cur.name;
            if (argsTextFromItem) cur.argsText = (cur.argsText || '') + argsTextFromItem;
            toolCallsById.set(canonical, cur);
          }
        }
      }

      // Track response lifecycle (best-effort; different models may emit
      // different message types).
      if (msg.type === 'response.created') {
        responseIsActive = true;
        assistantSpeaking = true;
        activeResponseId = msg?.response?.id || msg?.response_id || msg?.id || activeResponseId;
      }
      if (msg.type === 'response.done' || msg.type === 'response.cancelled' || msg.type === 'response.audio.done') {
        responseIsActive = false;
        assistantSpeaking = false;
        activeResponseId = null;
      }

      if (msg.type === 'response.audio.delta' && msg.delta) {
        // Receiving audio deltas implies a response is active, even if we didn't
        // observe a `response.created` event.
        responseIsActive = true;

        // If the caller is talking, suppress assistant audio to avoid talking
        // over them.
        if (bargeInActive) return;

        // Best-effort: if OpenAI includes a response id, ignore deltas from older responses.
        if (activeResponseId && msg?.response_id && msg.response_id !== activeResponseId) return;

        enqueueOutAudio(msg.delta);
      }

      if (msg.type === 'error') {
        const code = msg?.error?.code;
        if (code === 'response_cancel_not_active') {
          // This can happen if we attempted to cancel but OpenAI had no active response.
          // Mark locally inactive so we don't spam cancels.
          responseIsActive = false;
          console.log('[openai][warn]', { code, message: msg?.error?.message });
        } else {
          console.error('[openai][error]', msg);
        }
      }
    });

    openaiWs.on('close', (code, reason) => {
      console.warn('[openai][ws_close]', {
        callSid: tokenPayload?.callSid,
        agent: tokenPayload?.agent,
        code,
        reason: reason?.toString?.(),
      });
      try {
        twilioWs.close();
      } catch {
        // ignore
      }
    });

    openaiWs.on('error', (err) => {
      console.error('[openai][ws_error]', err);
      try {
        twilioWs.close();
      } catch {
        // ignore
      }
    });
  }

  console.log('[twilio][ws_connect]', {
    remote,
    preverified: !!tokenPayload,
  });

  // If Twilio did not provide token in query string, require it shortly after connect.
  const authTimeout = setTimeout(() => {
    if (!tokenPayload) {
      console.warn('[twilio][auth_timeout]', { remote });
      try {
        twilioWs.close();
      } catch {
        // ignore
      }
    }
  }, 8000);

  twilioWs.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('[twilio][stream_start]', { streamSid });

      if (!tokenPayload) {
        const cp = msg.start?.customParameters || msg.start?.custom_parameters || {};
        const candidateToken = cp.token || cp.Token || cp.TOKEN || null;

        const tokenStr = (candidateToken || '').toString();
        const tokenMeta = {
          present: !!candidateToken,
          len: tokenStr.length,
          dotCount: (tokenStr.match(/\./g) || []).length,
          parts: tokenStr.split('.').length,
          customParamKeys: Object.keys(cp),
        };

        if (!candidateToken) {
          console.warn('[twilio][auth_reject] missing_token_in_customParameters', { tokenMeta });
          try {
            twilioWs.close();
          } catch {
            // ignore
          }
          return;
        }

        const v = verifyToken(candidateToken);
        if (!v.ok) {
          console.warn('[twilio][auth_reject] bad_token_in_customParameters', {
            reason: v.reason,
            tokenMeta,
          });
          try {
            twilioWs.close();
          } catch {
            // ignore
          }
          return;
        }

        tokenPayload = v.payload;
        console.log('[twilio][auth_ok]', {
          callSid: tokenPayload?.callSid,
          agent: tokenPayload?.agent,
        });
      }

      clearTimeout(authTimeout);

      // Start OpenAI session once we're authenticated.
      try {
        await startOpenAiSession();
      } catch (err) {
        console.error('[bridge][connection_error]', err);
        try {
          twilioWs.close();
        } catch {
          // ignore
        }
        try {
          openaiWs?.close();
        } catch {
          // ignore
        }
        return;
      }

      startOutSendLoop();
      maybeSendInitialResponse();
      return;
    }

    if (msg.event === 'media') {
      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
        queueTwilioToOpenAi(payload);
        return;
      }

      openAiSend(openaiWs, {
        type: 'input_audio_buffer.append',
        audio: payload,
      });
      return;
    }

    if (msg.event === 'stop') {
      console.log('[twilio][stream_stop]', { streamSid });
      try {
        openaiWs?.close();
      } catch {
        // ignore
      }
    }
  });

  twilioWs.on('close', () => {
    console.warn('[twilio][ws_close]', {
      callSid: tokenPayload?.callSid,
      agent: tokenPayload?.agent,
      streamSid,
    });
    clearTimeout(authTimeout);
    stopOutSendLoop();
    clearOutAudio('twilio_ws_close');
    try {
      openaiWs?.close();
    } catch {
      // ignore
    }
  });

  twilioWs.on('error', (err) => {
    console.error('[twilio][ws_error]', err);
    clearTimeout(authTimeout);
    stopOutSendLoop();
    clearOutAudio('twilio_ws_error');
    try {
      openaiWs?.close();
    } catch {
      // ignore
    }
  });
});

function startCacheScheduler() {
  // Warm on boot.
  refreshSitrepCache({ force: true }).catch(() => {});

  // Periodic refresh (default 30 minutes) with a bit of jitter so it doesn't
  // align perfectly with upstream maintenance windows.
  const jitterSeconds = Math.floor(Math.random() * 30);
  const intervalMs = Math.max(10, SITREP_REFRESH_SECONDS) * 1000;

  setInterval(
    () => {
      refreshSitrepCache({ force: true }).catch(() => {});
    },
    intervalMs + jitterSeconds * 1000,
  );
}

startCacheScheduler();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[odin-realtime-bridge] listening on :${PORT}`);
});

// ============================================
// WebCliniQ — /api/audit-stream (Netlify Edge Function, Deno)
// ------------------------------------------
// Streaming version of the audit engine. Email capture stays in
// netlify/functions/audit.js (Node) — this file only runs checks and
// streams progress events back as Server-Sent Events.
//
// Stream events: searching, match, listing, website, pagespeed,
// enrichment, complete, error.
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY') || Deno.env.get('PAGESPEED_API_KEY');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabase) console.error('Supabase not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

const fetchWithTimeout = async (url, options = {}) => {
  const { timeout = 7000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

/* ---------- Finding helpers ---------- */

const SEVERITY_WEIGHT = { critical: 100, high: 70, medium: 40, low: 20, clear: 0 };

// Severity first; within the same severity, listing findings sort before website
// findings (GBP breaks ties). `bump` lets a check nudge itself up by how bad the
// measured value actually is.
function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const sa = (SEVERITY_WEIGHT[a.severity] ?? 0) + (a.bump || 0);
    const sb = (SEVERITY_WEIGHT[b.severity] ?? 0) + (b.bump || 0);
    if (sb !== sa) return sb - sa;
    return (a.domain === 'listing' ? 0 : 1) - (b.domain === 'listing' ? 0 : 1);
  });
}

// critical/high/medium move the score; low does not. The always-on improvement
// layer is all `low`, so a practice's punch-list of missing pages surfaces in
// "+N more" without dragging every score to the floor — but real, specific
// problems (thin reviews, no hours, a slow-ish site) still pull it down.
function computeScore(findings) {
  let score = 85;
  for (const f of findings) {
    if (f.severity === 'critical') score -= 15;
    else if (f.severity === 'high') score -= 8;
    else if (f.severity === 'medium') score -= 4;
  }
  return Math.max(20, Math.min(85, score));
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) return null;
  try {
    // A rolling alias, not a dated snapshot — dated models (e.g. gemini-2.0-flash)
    // get retired by Google and start 404ing with no warning.
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
        }),
        timeout: 8000,
      }
    );
    if (!res.ok) {
      console.error('Gemini call failed:', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    return text ? text.trim() : null;
  } catch (e) {
    console.error('Gemini call failed:', e.message);
    return null;
  }
}

// Sharpens a handful of data-rich findings with the actual numbers, and
// writes one plain-language summary paragraph. Best-effort: any failure
// (missing key, bad JSON, network) degrades to no sharpening / no summary
// rather than breaking the audit.
const SHARPENABLE_KEYS = ['reviews', 'reviews-vs-area', 'phone-speed', 'nap-consistency', 'review-recency'];

async function enrichWithAI(findings, matched, practiceType, city, hadWebsite, nearbyTop3) {
  const name = (matched && matched.name) || 'this practice';
  const typeLabel = TYPE_LABELS[practiceType] || 'healthcare practice';
  const locationLabel = city || 'your area';

  const enrichable = findings.filter((f) => SHARPENABLE_KEYS.includes(f.key) && f.severity !== 'clear');
  // The key in brackets is what must come back verbatim in "sharpened" — the
  // model has no other reliable way to know our internal finding keys.
  const findingLines = enrichable.map((f) =>
    `- [${f.key}] ${f.title}: ${f.value || ''}${f.benchmark ? ` (benchmark: ${f.benchmark})` : ''}${nearbyTop3 ? ` (nearby competitors: ${nearbyTop3.join(', ')} reviews)` : ''}`
  ).join('\n');

  const allFlagged = findings
    .filter((f) => f.severity !== 'clear' && f.severity !== 'low')
    .slice(0, 6)
    .map((f) => `${f.title}: ${f.value || 'flagged'}`)
    .join(', ');

  const prompt = `You write copy for a healthcare web presence audit tool. Be direct and specific. No jargon. Write as if speaking to the practice owner, not a developer. Address the owner as "you" and "your practice" throughout. Only state what the data shows: do not guess what patients think or feel, and do not promise results. Never use em dashes; use commas or full stops instead. Avoid stock phrases such as "crucial", "elevate", "seamless", "in today's digital world" and "it's not just X, it's Y".

Practice: ${name}
Type: ${typeLabel}
City: ${locationLabel}
Has website: ${hadWebsite ? 'yes' : 'no'}
Key issues found: ${allFlagged}

TASK 1: SHARPEN these finding consequences using the actual data. One sentence each. Use the numbers. Name the practice type and city where it adds weight. In your JSON, use the bracketed key exactly as given (e.g. "[phone-speed]" becomes the key "phone-speed"), not the title.
${findingLines}

TASK 2: Write one summary paragraph (3-4 sentences). Use the practice name once. Connect the most important findings into a plain picture of where they stand. Be honest, not alarming. End with the one fix that matters most and why, without promising an outcome.

Respond ONLY with valid JSON:
{
  "sharpened": { "finding-key": "sharpened consequence", ... },
  "summary": "paragraph"
}`;

  const raw = await callGemini(prompt);
  if (!raw) return { summary: null, sharpened: {} };

  try {
    const clean = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(clean);
    const noDash = (s) => (typeof s === 'string' ? s.replace(/\s*—\s*/g, ', ') : s);
    parsed.summary = noDash(parsed.summary);
    for (const k of Object.keys(parsed.sharpened || {})) parsed.sharpened[k] = noDash(parsed.sharpened[k]);
    return parsed;
  } catch (e) {
    console.error('Gemini parse failed:', e.message);
    return { summary: null, sharpened: {} };
  }
}

function stripHost(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return (u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

// Back-compat: script.js reads .flag / .category / .text.
function withAliases(f) {
  const parts = [];
  if (f.value) parts.push(`${f.title}: ${f.value}${f.benchmark ? ` vs ${f.benchmark}` : ''}`);
  else parts.push(f.title);
  if (f.consequence) parts.push(f.consequence);
  return {
    ...f,
    flag: f.severity === 'clear' ? 'ok' : 'warn',
    category: f.title,
    text: parts.join('. '),
  };
}

/* ---------- Helpers ---------- */
function parseInput(input) {
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  // Only one comma-separated part should ever be the URL; everything else is
  // the business name, rejoined — a name can legitimately contain a comma
  // (e.g. a branch suffix: "SAGE Dental Clinic, MBROM"), and treating every
  // non-URL part as an overwrite silently threw away everything but the
  // last segment.
  const urlPattern = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/[^\s]*)?$/;
  let url = null;
  const nameParts = [];
  for (const part of parts) {
    if (!url && urlPattern.test(part)) url = part.startsWith('http') ? part : `https://${part}`;
    else nameParts.push(part);
  }
  const businessName = nameParts.length ? nameParts.join(', ') : null;
  return { url, businessName };
}

function detectHealthcareNiche(url, businessName, types) {
  const HEALTHCARE_TYPES = ['dentist', 'doctor', 'hospital', 'health', 'physiotherapist', 'pharmacy', 'veterinary_care', 'medical_lab', 'wellness_center', 'spa'];
  if (types && types.some((t) => HEALTHCARE_TYPES.includes(t))) return true;
  if (types && types.length) return false;
  const keywords = ['clinic', 'dental', 'dentist', 'health', 'medical', 'doctor', 'physio', 'chiro', 'care', 'hospital', 'derma', 'therapy', 'nursing'];
  const content = `${url || ''} ${businessName || ''}`.toLowerCase();
  return keywords.some((kw) => content.includes(kw));
}

function urlsMatch(url1, url2) {
  return stripHost(url1).toLowerCase() === stripHost(url2).toLowerCase();
}

function parseIPv4Host(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : null;
  });
  return nums.some((n) => n == null) ? null : nums;
}

function ipv4HostIsPublic(host) {
  const p = parseIPv4Host(host);
  if (!p) return true;
  const [a, b, c] = p;
  if (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) return false;
  return true;
}

function parseIPv6Host(host) {
  let value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!value.includes(':') || value.includes('%')) return null;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const tail = parseIPv4Host(value.slice(lastColon + 1));
    if (!tail) return null;
    value = `${value.slice(0, lastColon)}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (![...left, ...right].every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((part) => parseInt(part, 16));
  if (groups.length !== 8 || groups.some((n) => Number.isNaN(n))) return null;
  return groups.reduce((acc, n) => (acc << 16n) + BigInt(n), 0n);
}

function ipv6HostIsPublic(host) {
  const value = parseIPv6Host(host);
  if (value == null) return true;
  const base = (ip) => parseIPv6Host(ip);
  const inRange = (ip, bits) => (value >> BigInt(128 - bits)) === (base(ip) >> BigInt(128 - bits));
  const mapped = inRange('::ffff:0:0', 96);
  if (mapped) {
    const v4 = Number(value & 0xffffffffn);
    return ipv4HostIsPublic(`${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
  }
  return ![
    ['::', 128], ['::1', 128], ['::', 8], ['64:ff9b::', 96],
    ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
    ['2001:2::', 48], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ].some(([ip, bits]) => inRange(ip, bits));
}

// Edge prefilter only. Untrusted website fetching runs in the Node content
// worker, where DNS answers are validated and pinned before connecting.
function isPublicHttpUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host === 'metadata' || host === 'metadata.google.internal') return false;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) return false;
  if (!host.includes('.') && !host.includes(':')) return false;
  if (!ipv4HostIsPublic(host) || !ipv6HostIsPublic(host)) return false;
  return true;
}

/* ---------- Website: PageSpeed Insights ---------- */
async function runPageSpeedCheck(targetUrl, apiKey, timeoutMs) {
  const findings = [];
  const isHttps = targetUrl.startsWith('https://');
  const httpsFinding = isHttps
    ? { key: 'secure-connection', domain: 'website', severity: 'clear', title: 'Site security warning', value: 'no warning shown' }
    : { key: 'secure-connection', domain: 'website', severity: 'critical', title: 'Site security warning', value: 'visible to patients', consequence: "Patients visiting your site see a 'Not secure' warning in their browser. Many will leave rather than enter their details.", fix: 'SSL fix', verdictPhrase: 'the security warning patients see on your site' };

  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&strategy=mobile&category=performance&category=seo&category=accessibility${apiKey ? `&key=${apiKey}` : ''}`;
    // PSI's lab run is slow and highly variable (8-14s typical, longer for heavy
    // sites). Caller sets the budget.
    const res = await fetchWithTimeout(endpoint, { timeout: timeoutMs || 18000 });
    if (!res.ok) {
      const err = new Error(`PSI HTTP ${res.status}`);
      err.psiStatus = res.status;
      throw err;
    }
    const data = await res.json();

    if (!data.lighthouseResult || !data.lighthouseResult.categories) {
      const field = data.loadingExperience && data.loadingExperience.metrics;
      const lcpMs = field && field.LARGEST_CONTENTFUL_PAINT_MS && field.LARGEST_CONTENTFUL_PAINT_MS.percentile;
      if (lcpMs) {
        const secs = (lcpMs / 1000).toFixed(1);
        findings.push(lcpMs > 2500
          ? { key: 'phone-speed', domain: 'website', severity: 'high', title: 'Mobile load speed', value: `${secs}s`, benchmark: "Google's bar is 2.5s", consequence: 'Slow enough that many phone visitors leave before it loads.', fix: 'Speed Fix', verdictPhrase: 'your phone-site speed' }
          : { key: 'phone-speed', domain: 'website', severity: 'clear', title: 'Mobile load speed', value: `${secs}s (real-user)` });
      } else {
        const rawMsg = ((data.error && data.error.message) || '').toLowerCase();
        let text = "That website couldn't be fully checked right now.";
        let severity = 'low';
        if (rawMsg.includes('failed_document_request') || rawMsg.includes('err_connection') || rawMsg.includes('dns')) { text = "That website couldn't be reached. Double-check the address is correct and the site is live."; severity = 'medium'; }
        else if (rawMsg.includes('timeout')) { text = 'That site took too long to respond, so the check couldn\'t finish.'; severity = 'medium'; }
        console.error('PSI failed for', targetUrl, JSON.stringify(data).slice(0, 400));
        findings.push({ key: 'site-check', domain: 'website', severity, title: 'Website check', value: 'incomplete', consequence: text });
      }
      findings.push(httpsFinding);
      return { findings, screenshot: null };
    }

    const lh = data.lighthouseResult;
    const A = lh.audits || {};
    const pct = (c) => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : null);
    const perfScore = pct(lh.categories.performance);
    const seoScore = pct(lh.categories.seo);
    const a11yScore = lh.categories.accessibility ? Math.round((lh.categories.accessibility.score || 0) * 100) : null;
    const crawlable = A['is-crawlable'];
    const screenshot = (A['final-screenshot'] && A['final-screenshot'].details && A['final-screenshot'].details.data) || null;
    const lcpSecs = A['largest-contentful-paint'] && A['largest-contentful-paint'].numericValue
      ? (A['largest-contentful-paint'].numericValue / 1000).toFixed(1) : null;

    if (crawlable && crawlable.score === 0) {
      findings.push({ key: 'crawlable', domain: 'website', severity: 'critical', title: 'Hidden from Google', value: 'blocking Google', consequence: 'Your site is telling Google not to list it. It may not appear in search at all.', fix: 'Crawlability fix', verdictPhrase: 'the pages hidden from Google' });
    }

    if (perfScore == null) {
      // Lighthouse gave no performance score; say nothing rather than guess.
    } else if (perfScore < 70) {
      findings.push({ key: 'phone-speed', domain: 'website', severity: perfScore < 45 ? 'high' : 'medium', bump: perfScore < 45 ? 10 : 0, title: 'Mobile load speed', value: lcpSecs ? `${lcpSecs}s to load` : `${perfScore}/100`, benchmark: "patients bounce past ~3s", consequence: 'Slow enough that visitors may leave before it loads.', fix: 'Speed Fix', verdictPhrase: 'your phone-site speed' });
    } else {
      findings.push({ key: 'phone-speed', domain: 'website', severity: 'clear', title: 'Mobile load speed', value: lcpSecs ? `${lcpSecs}s` : `${perfScore}/100` });
    }

    // The single biggest, most concrete speed cause — a number, not a grade.
    const opp = biggestSpeedOpportunity(A);
    if (opp && perfScore != null && perfScore < 90) findings.push(opp);

    if (seoScore == null) {
      // No SEO score returned; nothing to report.
    } else if (seoScore < 80) {
      findings.push({ key: 'search-basics', domain: 'website', severity: 'medium', title: 'Google search basics', value: `${seoScore}/100`, consequence: 'Missing on-page basics that help patients find your specialty on Google.', fix: 'On-page SEO', verdictPhrase: 'your search basics' });
    } else {
      findings.push({ key: 'search-basics', domain: 'website', severity: 'clear', title: 'Google search basics', value: `${seoScore}/100` });
    }

    if (a11yScore != null) {
      if (a11yScore < 85) {
        findings.push({ key: 'accessibility', domain: 'website', severity: 'medium', title: 'Easy to read for all patients', value: `${a11yScore}/100`, consequence: 'Low-contrast text, unlabelled buttons and small tap targets shut out older patients and anyone using a screen reader.', fix: 'Accessibility pass', verdictPhrase: 'accessibility' });
      } else {
        findings.push({ key: 'accessibility', domain: 'website', severity: 'clear', title: 'Easy to read for all patients', value: `${a11yScore}/100` });
      }
    }

    findings.push(httpsFinding);
    return { findings, screenshot };
  } catch (e) {
    findings.push(e.name === 'AbortError'
      ? { key: 'phone-speed', domain: 'website', severity: 'high', title: 'Mobile load speed', value: 'too slow to measure', consequence: 'Your site took too long to load on a phone. Most patients will leave before it opens.', fix: 'Speed Fix', verdictPhrase: 'your mobile load speed' }
      : (e.psiStatus && e.psiStatus !== 400)
        ? { key: 'site-check', domain: 'website', severity: 'low', title: 'Website check', value: 'incomplete', consequence: "That website couldn't be fully checked right now." }
        : { key: 'site-reach', domain: 'website', severity: 'medium', title: 'Website check', value: 'unreachable', consequence: `${targetUrl} couldn't be reached for a check.` });
    findings.push(httpsFinding);
    return { findings, screenshot: null };
  }
}

// Turns Lighthouse's opportunity audits into one plain, numeric finding.
function biggestSpeedOpportunity(A) {
  const cands = [
    { id: 'uses-optimized-images', label: 'Large images slowing your site', fix: 'Speed Fix' },
    { id: 'modern-image-formats', label: 'Images in old formats', fix: 'Speed Fix' },
    { id: 'render-blocking-resources', label: 'Code slowing page load', fix: 'Speed Fix' },
    { id: 'unused-javascript', label: 'Unnecessary code', fix: 'Speed Fix' },
    { id: 'unminified-javascript', label: 'Unminified JavaScript', fix: 'Speed Fix' },
    { id: 'server-response-time', label: 'Slow hosting', fix: 'Hosting review' },
  ];
  let best = null;
  for (const c of cands) {
    const a = A[c.id];
    const ms = a && a.details && (a.details.overallSavingsMs || a.numericValue);
    if (ms && ms > (best ? best.ms : 700)) best = { ...c, ms };
  }
  if (A['total-byte-weight'] && A['total-byte-weight'].numericValue > 3_000_000) {
    const mb = (A['total-byte-weight'].numericValue / 1_000_000).toFixed(1);
    if (!best || best.ms < 1500) return { key: 'page-weight', domain: 'website', severity: 'medium', title: 'Site too heavy to load', value: `${mb} MB homepage`, consequence: 'Every visit downloads that much, which is slow and costly on a phone plan.', fix: 'Speed Fix' };
  }
  if (!best) return null;
  return { key: 'speed-cause', domain: 'website', severity: 'medium', title: best.label, value: `~${(best.ms / 1000).toFixed(1)}s to save`, consequence: 'The biggest single thing slowing your page down.', fix: best.fix };
}

/* ---------- Website content: delegated to Node function for SSRF protection ---------- */
async function runWebsiteContentCheck(targetUrl, requestUrl) {
  const findings = [];
  const finalUrl = targetUrl;
  if (!isPublicHttpUrl(targetUrl)) return { findings, html: '', finalUrl };
  try {
    const endpoint = new URL('/.netlify/functions/content-audit', requestUrl).href;
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
      redirect: 'error',
      timeout: 16000,
    });
    if (!res.ok) throw new Error(`content worker HTTP ${res.status}`);
    const data = await res.json();
    return {
      findings: Array.isArray(data.findings) ? data.findings : [],
      html: typeof data.html === 'string' ? data.html : '',
      finalUrl: data.finalUrl || finalUrl,
      spa: !!data.spa,
    };
  } catch (e) {
    console.error('content worker failed for', targetUrl, e.message);
    return { findings, html: '', finalUrl };
  }
}
/* ---------- Listing: Google Places ---------- */
// A typed name must plausibly overlap the matched listing's name. Skipped for
// single-token queries derived from a domain (e.g. "aspendental").
function nameLooksLikeMatch(typed, found) {
  if (!found) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const t = norm(typed);
  if (t.length < 2) return true;
  const f = new Set(norm(found));
  const overlap = t.filter((w) => f.has(w)).length;
  return overlap >= Math.max(1, Math.ceil(t.length * 0.4));
}

// Every phone number on the homepage, as a normalised 9-digit tail. Practices
// often show several (landline, mobile, WhatsApp), so a NAP mismatch is only
// claimed when the Google number is missing from all of them. tel: links count
// first; visible text is scanned too (never scripts/styles/markup, which hide
// analytics IDs and JSON-LD fields), skipping anything preceded by a currency
// symbol (a price, not a number).
function extractPhonesFromHtml(html) {
  const found = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 7) found.add(normalisePhone(digits));
  }
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const c of visible.match(/[$£€]?\s*\+?\d[\d\s\-().]{6,18}\d/g) || []) {
    if (/^[$£€]/.test(c.trim())) continue;
    const digits = c.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) found.add(normalisePhone(digits));
  }
  return found;
}

function napFinding(gbpPhone, html) {
  if (!gbpPhone || !html) return null;
  const gbp = normalisePhone(gbpPhone);
  const onSite = extractPhonesFromHtml(html);
  if (!gbp || !onSite.size || onSite.has(gbp)) return null;
  return { key: 'nap-consistency', domain: 'listing', severity: 'high', title: 'Phone number mismatch', value: 'not on your site', consequence: "The phone number on your Google listing doesn't appear on your website. Google uses consistent details as a trust signal in local rankings, so a mismatch can count against you.", fix: 'NAP correction' };
}

function normalisePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-9);
}

const TYPE_LABELS = {
  dentist: 'dental clinics',
  physiotherapist: 'physiotherapy practices',
  doctor: 'medical practices',
  hospital: 'hospitals',
  pharmacy: 'pharmacies',
  veterinary_care: 'vet practices',
  spa: 'wellness centres',
};

async function runGooglePlacesCheck(targetQuery, apiKey) {
  const findings = [];
  if (!apiKey) return { findings, website: null, found: false, types: [] };

  try {
    const looksLikeUrl = !/\s/.test(targetQuery) && /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/|$)/.test(targetQuery);
    const cleanQuery = looksLikeUrl
      ? targetQuery.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0].trim()
      : targetQuery.trim();
    // findplacefromtext only accepts Basic + Atmosphere fields. `website`,
    // full `opening_hours` and `reviews` need a follow-up Place Details call.
    const fields = 'place_id,name,rating,user_ratings_total,types,photos,geometry';
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(cleanQuery)}&inputtype=textquery&fields=${fields}&key=${apiKey}`;
    const res = await fetchWithTimeout(searchUrl);
    const data = await res.json();

    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Places findplacefromtext error:', data.status, data.error_message || '');
      findings.push({ key: 'listing-check', domain: 'listing', severity: 'medium', title: 'Google listing', value: 'not checked', consequence: "Couldn't check your Google listing right now. Try again shortly." });
      return { findings, website: null, found: false, types: [] };
    }

    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !nameLooksLikeMatch(cleanQuery, candidate.name)) {
      findings.push({ key: 'no-listing', domain: 'listing', severity: 'critical', title: 'Google listing', value: 'not found', consequence: 'No Google listing found under this name, so patients searching Maps for a nearby practice never see you.', fix: 'Listing setup + verification', verdictPhrase: 'your missing Google listing' });
      return { findings, website: null, found: false, types: [] };
    }

    const rating = candidate.rating || 0;
    const reviews = candidate.user_ratings_total || 0;
    const placeId = candidate.place_id || null;
    const location = (candidate.geometry && candidate.geometry.location) || null;
    const nearbyType = pickNearbyType(candidate.types);

    // Place Details (website + real hours + review recency), nearby review
    // stats, reverse geocoding, and the prominence-rank search all run
    // together, still parallel to PageSpeed.
    const [details, nearbyStats, city, prominenceRank] = await Promise.all([
      placeId ? getPlaceDetails(placeId, apiKey) : Promise.resolve({}),
      (location && nearbyType) ? getNearbyReviewStats(location, nearbyType, placeId, apiKey) : Promise.resolve(null),
      location ? getCityFromCoords(location.lat, location.lng, apiKey) : Promise.resolve(null),
      (location && nearbyType && placeId) ? getProminenceRank(location, nearbyType, placeId, apiKey) : Promise.resolve(null),
    ]);
    const detailsFailed = !details;
    const d = details || {};
    const website = d.website || null;
    const hoursSet = !!(d.openingHours && (d.openingHours.weekday_text || d.openingHours.periods));
    const reviewAgeDays = d.newestReviewDays ?? null;
    const nearbyMedian = nearbyStats ? nearbyStats.median : null;
    const nearbyTop3 = nearbyStats && nearbyStats.top3 && nearbyStats.top3.length ? nearbyStats.top3 : null;

    // The listing itself says the practice is closed — outranks everything else.
    if (d.businessStatus === 'CLOSED_PERMANENTLY' || d.businessStatus === 'CLOSED_TEMPORARILY') {
      const perm = d.businessStatus === 'CLOSED_PERMANENTLY';
      findings.push({ key: 'business-closed', domain: 'listing', severity: 'critical', title: perm ? 'Listed as permanently closed' : 'Listed as temporarily closed', value: 'on Google', consequence: perm ? 'Google shows your practice as closed, so patients searching for you are sent elsewhere.' : "Google shows you as closed right now, so patients who would call are turned away before they try.", fix: 'Listing correction', verdictPhrase: 'your listing showing as closed' });
    }

    // One reviews finding, decided with the best data available.
    if (!reviews) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'high', title: 'Google reviews', value: 'none yet', consequence: 'Patients compare practices on reviews before anything else.', fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (nearbyMedian && nearbyMedian >= 10 && reviews < nearbyMedian * 0.5) {
      const far = reviews < nearbyMedian * 0.33;
      const benchmark = nearbyTop3 ? `nearby: ${nearbyTop3.join(', ')}` : `area median ${nearbyMedian}`;
      const consequence = nearbyTop3
        ? `The closest ${nearbyTop3.length} practices carry ${nearbyTop3.join(', ')} reviews. Patients compare, and many pick the bigger number.`
        : `Practices near you carry around ${nearbyMedian} reviews. Patients compare, and many pick the bigger number.`;
      findings.push({ key: 'reviews', domain: 'listing', severity: far ? 'high' : 'medium', bump: far ? 10 : 0, title: 'Reviews vs. your area', value: `${reviews} · ${rating}★`, benchmark, consequence, fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (reviews < 5) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'medium', title: 'Google reviews', value: `${reviews} · ${rating}★`, consequence: 'Thin next to nearby practices, and patients compare.', fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (rating && rating < 4.3) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'medium', title: 'Google rating', value: `${rating}★ · ${reviews} reviews`, benchmark: 'patients trust 4.3★+', consequence: 'Below the rating most patients will book from without a second look.', fix: 'Reputation repair + review flow', verdictPhrase: 'your rating' });
    } else if (!nearbyMedian && reviews < 15) {
      // No area data to compare against, and the count itself is on the low
      // side — calling this "clear" would be green on thin data.
      findings.push({ key: 'reviews', domain: 'listing', severity: 'medium', title: 'Google reviews', value: `${reviews} · ${rating}★`, consequence: "This couldn't be compared to nearby practices, and it's on the low side. Worth building up.", fix: 'Review system', verdictPhrase: 'your reviews' });
    } else {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'clear', title: 'Google reviews', value: `${reviews} · ${rating}★` });
    }

    if (reviews && reviewAgeDays != null && reviewAgeDays > 90) {
      const months = Math.round(reviewAgeDays / 30);
      findings.push({ key: 'review-recency', domain: 'listing', severity: 'high', title: 'Review recency', value: `newest is ~${months} mo old`, consequence: 'A listing with no recent reviews reads as a practice that has gone quiet, or closed.', fix: 'Review system', verdictPhrase: 'your stale reviews' });
    }

    if (!detailsFailed && !hoursSet) {
      findings.push({ key: 'listing-hours', domain: 'listing', severity: 'medium', title: 'Opening hours on Google', value: 'not set', consequence: "Patients can't tell if you're open right now.", fix: 'Profile fill', verdictPhrase: 'your missing listing hours' });
    }

    if (!detailsFailed && !d.phone) {
      findings.push({ key: 'listing-phone', domain: 'listing', severity: 'medium', title: 'Phone number on Google', value: 'not set', consequence: "No number on your Google listing, so patients who want to call have to find it on your site first.", fix: 'Profile fill', verdictPhrase: 'the missing phone number on your listing' });
    }

    // A category like "Health" or "Point of interest" tells Google (and search)
    // nothing about what you actually treat — a specific one is how you surface
    // for "dentist near me" instead of just "business near me".
    const GENERIC_TYPES = new Set(['point_of_interest', 'establishment', 'health']);
    const hasSpecificType = (candidate.types || []).some((t) => !GENERIC_TYPES.has(t));
    if (!hasSpecificType) {
      findings.push({ key: 'listing-category', domain: 'listing', severity: 'low', title: 'Practice type on Google', value: 'too generic', consequence: "Your Google category doesn't say what you treat, so patients searching for a specific practice type may never see you.", fix: 'Profile fill' });
    }

    const photoCount = d.photoCount || (candidate.photos ? candidate.photos.length : 0);
    if (!photoCount) {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'medium', title: 'Listing photos', value: 'none', consequence: 'A listing with no photos looks abandoned, so patients scroll past to one that has them.', fix: 'Photo set' });
    } else if (photoCount < 6) {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'medium', title: 'Listing photos', value: `${photoCount} photo${photoCount === 1 ? '' : 's'}`, consequence: 'A handful of photos is thin next to practices with a full set of the space and team.', fix: 'Photo set' });
    } else {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'clear', title: 'Listing photos', value: `${photoCount} photos` });
    }

    const practiceTypeLabel = TYPE_LABELS[nearbyType] || 'healthcare practices';
    if (nearbyType && placeId && prominenceRank !== false) {
      // position is 1-indexed; null means not found in Google's top 20 nearby.
      if (prominenceRank === null || prominenceRank > 10) {
        findings.push({ key: 'maps-rank', domain: 'listing', severity: 'high', title: 'Google Maps ranking', value: 'outside top 10', consequence: `Your listing isn't appearing in the top 10 ${practiceTypeLabel} near you, so most patients searching Google Maps won't find you.`, fix: 'Local SEO' });
      } else if (prominenceRank <= 3) {
        findings.push({ key: 'maps-rank', domain: 'listing', severity: 'clear', title: 'Google Maps ranking', value: 'top 3 nearby' });
      } else if (prominenceRank <= 6) {
        findings.push({ key: 'maps-rank', domain: 'listing', severity: 'medium', title: 'Google Maps ranking', value: `#${prominenceRank} nearby`, consequence: `Ranked roughly #${prominenceRank} among ${practiceTypeLabel} near you. Patients usually pick from the top 3.`, fix: 'Local SEO' });
      } else {
        findings.push({ key: 'maps-rank', domain: 'listing', severity: 'high', title: 'Google Maps ranking', value: `#${prominenceRank} nearby`, consequence: `Ranked #${prominenceRank} among nearby ${practiceTypeLabel}. Most patients searching Maps won't scroll this far.`, fix: 'Local SEO' });
      }
    }

    return {
      findings,
      website,
      found: true,
      types: candidate.types || [],
      name: candidate.name || null,
      rating,
      reviews,
      placeId,
      location,
      city,
      prominenceRank: prominenceRank === false ? null : prominenceRank,
      nearbyTop3,
      detailsFailed,
      gbpPhone: d.phone || null,
    };
  } catch (e) {
    findings.push({ key: 'listing-check', domain: 'listing', severity: 'medium', title: 'Google listing', value: 'not checked', consequence: "Couldn't check your Google listing right now. Try again shortly." });
    return { findings, website: null, found: false, types: [] };
  }
}

// Places `type` values valid for a rankby=distance nearby search, healthcare only.
const NEARBY_TYPES = ['dentist', 'physiotherapist', 'doctor', 'hospital', 'pharmacy', 'veterinary_care', 'spa'];
function pickNearbyType(types) {
  if (!Array.isArray(types)) return null;
  return NEARBY_TYPES.find((t) => types.includes(t)) || null;
}

// One Place Details call for the fields findplacefromtext can't return.
async function getPlaceDetails(placeId, apiKey) {
  try {
    const fields = 'website,opening_hours,reviews,formatted_phone_number,business_status,photos';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&reviews_sort=newest&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    if (data.status !== 'OK') {
      console.error('Place Details error:', data.status, data.error_message || '');
      return null;
    }
    const r = data.result || {};
    const times = (r.reviews || []).map((x) => x.time).filter(Boolean);
    return {
      website: (r.website && isPublicHttpUrl(r.website)) ? r.website : null,
      openingHours: r.opening_hours || null,
      newestReviewDays: times.length ? Math.round((Date.now() / 1000 - Math.max(...times)) / 86400) : null,
      phone: r.formatted_phone_number || null,
      businessStatus: r.business_status || null,
      photoCount: Array.isArray(r.photos) ? r.photos.length : 0,
    };
  } catch (e) {
    console.error('Place Details failed:', e.message);
    return null;
  }
}

// Real review counts of the nearest same-type practices — concrete numbers beat
// a bare median.
async function getNearbyReviewStats(location, type, ownPlaceId, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&rankby=distance&type=${encodeURIComponent(type)}&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    const counts = (data.results || [])
      .filter((r) => r.place_id !== ownPlaceId && typeof r.user_ratings_total === 'number' && r.user_ratings_total > 0)
      .slice(0, 15)
      .map((r) => r.user_ratings_total)
      .sort((a, b) => b - a);
    if (counts.length < 4) return null;
    const asc = [...counts].sort((a, b) => a - b);
    const mid = Math.floor(asc.length / 2);
    return {
      median: asc.length % 2 ? asc[mid] : Math.round((asc[mid - 1] + asc[mid]) / 2),
      top3: counts.slice(0, 3),
    };
  } catch (e) {
    console.error('nearby stats check failed:', e.message);
    return null;
  }
}

// Turns the listing's lat/lng into a city name for copy/AI-enrichment context.
async function getCityFromCoords(lat, lng, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 4000 });
    const data = await res.json();
    const components = (data.results && data.results[0] && data.results[0].address_components) || [];
    const city = (components.find((c) => c.types.includes('locality')) || {}).long_name
      || (components.find((c) => c.types.includes('administrative_area_level_2')) || {}).long_name
      || null;
    return city;
  } catch (e) {
    console.error('Reverse geocoding failed:', e.message);
    return null;
  }
}

// Where the listing lands in a prominence-ranked nearby search — the same
// ordering patients see when Google Maps sorts by relevance rather than
// distance. 1-indexed; null means outside the top 20 returned; false means the
// lookup itself failed (so the caller must not claim a ranking either way).
async function getProminenceRank(location, type, ownPlaceId, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=5000&rankby=prominence&type=${encodeURIComponent(type)}&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Prominence rank error:', data.status, data.error_message || '');
      return false;
    }
    const results = data.results || [];
    const position = results.findIndex((r) => r.place_id === ownPlaceId);
    return position === -1 ? null : position + 1;
  } catch (e) {
    console.error('Prominence rank check failed:', e.message);
    return false;
  }
}

/* ---------- Streaming handler ---------- */
export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (event) => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch (e) {
      // Client disconnected — ignore
    }
  };

  // Run audit in background, stream closes when done
  runAudit(request, send)
    .catch((e) => console.error('runAudit crashed:', e && e.message))
    .finally(() => writer.close().catch(() => {}));

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};

async function runAudit(request, send) {
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    await send({ type: 'error', message: 'Invalid request.' });
    return;
  }

  const { value: rawValue } = payload || {};
  if (!rawValue || typeof rawValue !== 'string' || !rawValue.trim()) {
    await send({ type: 'error', message: 'Please enter a business name or website.' });
    return;
  }
  const value = rawValue.trim();
  if (value.length > 200) {
    await send({ type: 'error', message: 'That entry is too long. Enter just the practice name or its website address.' });
    return;
  }

  const { url, businessName } = parseInput(value);
  if (url && !isPublicHttpUrl(url)) {
    await send({ type: 'error', message: 'Please enter the practice name or its public website address.' });
    return;
  }
  const placesTarget = businessName || url;

  const clientIp = request.headers.get('x-nf-client-connection-ip')
    || request.headers.get('client-ip') || '0.0.0.0';

  // The audits row is created up front so the rate limit counts checks that are
  // still running (parallel requests) and ones that never finish, not just
  // completed ones. The same row is filled in when the check completes.
  let startedRowId = null;
  if (supabase) {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countError } = await supabase.from('audits')
        .select('*', { count: 'exact', head: true })
        .eq('ip_address', clientIp)
        .gte('created_at', oneHourAgo);
      if (countError) throw new Error(countError.message);
      if (count && count >= 5) {
        await send({ type: 'error', message: "You've run a few checks already. Give it a bit, then try again, or message me directly." });
        return;
      }
      const { data: started, error: startError } = await supabase.from('audits')
        .insert({ ip_address: clientIp, search_query: value })
        .select('id').single();
      if (startError) throw new Error(startError.message);
      startedRowId = started && started.id;
    } catch (e) {
      console.error('Rate limit check failed:', e.message);
      await send({ type: 'error', message: 'Something went wrong starting that check. Try again in a moment.' });
      return;
    }
  }

  // Activate panel immediately
  await send({ type: 'searching' });

  let listingFindings = [];
  let contentFindings = [];
  let speedFindings = [];
  let matched = null;
  let effectiveUrl = url || null;
  let placeTypes = [];
  let city = null;
  let prominenceRank = null;
  let nearbyTop3 = null;
  let screenshot = null;
  let mismatch = null;
  let noWebsiteConfirmed = false;
  let gbpPhone = null;
  let contentHtml = null;

  try {
    if (url) {
      // URL PATH: Places + PageSpeed + Content all start in parallel
      const placesPromise = placesTarget ? runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY) : Promise.resolve(null);
      const contentPromise = runWebsiteContentCheck(url, request.url);
      const speedPromise = runPageSpeedCheck(url, GOOGLE_API_KEY, 18000);

      // Send events as each resolves — order-independent
      placesPromise.then(async (r) => {
        if (!r) return;
        listingFindings = r.findings || [];
        placeTypes = r.types || [];
        city = r.city || null;
        prominenceRank = r.prominenceRank ?? null;
        nearbyTop3 = r.nearbyTop3 || null;
        gbpPhone = r.gbpPhone || null;
        if (r.found) {
          matched = { name: r.name, website: effectiveUrl };
          if (r.website && !urlsMatch(url, r.website)) {
            mismatch = "The website you entered doesn't match what's on this Google profile.";
          }
          await send({ type: 'match', name: r.name, website: effectiveUrl });
        }
        await send({ type: 'listing', findings: listingFindings });
      });

      contentPromise.then(async (r) => {
        if (!r) return;
        contentFindings = r.findings || [];
        contentHtml = r.spa ? null : (r.html || null);
        await send({ type: 'website', findings: contentFindings });
      });

      speedPromise.then(async (r) => {
        if (!r) return;
        speedFindings = r.findings || [];
        screenshot = r.screenshot || null;
        await send({ type: 'pagespeed', findings: speedFindings });
      });

      // Wait for all before enrichment
      await Promise.all([placesPromise, contentPromise, speedPromise]);

    } else {
      // NAME-ONLY PATH: Places must resolve first to get website URL
      const listingResult = placesTarget
        ? await runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY)
        : null;

      if (listingResult && listingResult.found) {
        matched = { name: listingResult.name, website: listingResult.website };
        effectiveUrl = listingResult.website || null;
        placeTypes = listingResult.types || [];
        city = listingResult.city || null;
        prominenceRank = listingResult.prominenceRank ?? null;
        nearbyTop3 = listingResult.nearbyTop3 || null;
        gbpPhone = listingResult.gbpPhone || null;
        listingFindings = listingResult.findings || [];

        await send({ type: 'match', name: listingResult.name, website: effectiveUrl });

        if (effectiveUrl) {
          // The site we're about to check came from the listing, not something
          // the visitor typed — note that, same as the non-streaming engine does.
          listingFindings.push({
            key: 'site-source', domain: 'website', severity: 'clear', title: 'Website checked',
            value: 'from your listing', consequence: `Checked ${stripHost(effectiveUrl)}, the site linked on your Google profile.`,
          });
        }
        await send({ type: 'listing', findings: listingFindings });

        if (effectiveUrl) {
          // Run content and speed in parallel
          const contentPromise = runWebsiteContentCheck(effectiveUrl, request.url);
          const speedPromise = runPageSpeedCheck(effectiveUrl, GOOGLE_API_KEY, 15000);

          // Send as each resolves
          contentPromise.then(async (r) => {
            if (!r) return;
            contentFindings = r.findings || [];
            contentHtml = r.spa ? null : (r.html || null);
            await send({ type: 'website', findings: contentFindings });
          });

          speedPromise.then(async (r) => {
            if (!r) return;
            speedFindings = r.findings || [];
            screenshot = r.screenshot || null;
            await send({ type: 'pagespeed', findings: speedFindings });
          });

          await Promise.all([contentPromise, speedPromise]);
        }
      } else if (listingResult) {
        // Listing checked but not found
        listingFindings = listingResult.findings || [];
        await send({ type: 'listing', findings: listingFindings });
      }

      if (!effectiveUrl && listingResult && listingResult.found && !listingResult.detailsFailed) {
        noWebsiteConfirmed = true;
        listingFindings.push({
          key: 'no-website', domain: 'website', severity: 'critical',
          title: 'No website', value: 'none linked on Google',
          consequence: 'Every patient who finds you on Google has nowhere to go to see what you treat, check whether you are a fit, or book.',
          fix: 'Starter site', verdictOverride: 'The biggest gap: no website to send patients to.'
        });
      }
    }

    const nap = napFinding(gbpPhone, contentHtml);
    if (nap) listingFindings.push(nap);

    // Merge and sort all findings
    const raw = [...listingFindings, ...contentFindings, ...speedFindings];
    const allFindings = sortFindings(raw).map(withAliases);
    let score = computeScore(allFindings);
    if (noWebsiteConfirmed) score = Math.min(score, 45);

    const practiceType = placeTypes.find(t =>
      ['dentist','physiotherapist','doctor','hospital','pharmacy','veterinary_care'].includes(t)
    ) || null;

    // Gemini enrichment — needs all findings
    const aiEnrichment = await enrichWithAI(
      allFindings, matched, practiceType, city, !!effectiveUrl, nearbyTop3
    );

    if (aiEnrichment?.sharpened) {
      allFindings.forEach(f => {
        const sharp = aiEnrichment.sharpened[f.key];
        if (sharp && typeof sharp === 'string' && f.severity !== 'clear' && SHARPENABLE_KEYS.includes(f.key)) f.consequence = sharp;
      });
    }

    await send({
      type: 'enrichment',
      summary: aiEnrichment?.summary || null,
      sharpened: aiEnrichment?.sharpened || {}
    });

    // critical/high first, capped at 5; if a clean practice has none, fall back
    // to the top non-clear findings so the panel is never empty.
    let shown = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high').slice(0, 5);
    if (!shown.length) shown = allFindings.filter(f => f.severity !== 'clear').slice(0, 3);
    const moreCount = Math.max(0, allFindings.filter(f => f.severity !== 'clear').length - shown.length);
    const publicId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

    // Save to Supabase
    let auditId = null;
    if (supabase) {
      try {
        const fields = {
          ip_address: clientIp,
          search_query: value,
          health_score: score,
          top_findings: shown,
          all_findings: allFindings,
          had_website: !!effectiveUrl,
          had_business_name: !!businessName || !!matched,
          public_id: publicId,
          screenshot: screenshot || null,
          ai_summary: aiEnrichment?.summary || null,
          city: city || null,
        };
        const table = supabase.from('audits');
        const { data: row, error } = await (startedRowId
          ? table.update(fields).eq('id', startedRowId)
          : table.insert(fields)).select('id').single();
        if (error) console.error('audits insert failed:', error.message);
        else auditId = row?.id;
      } catch (e) {
        console.error('audits insert threw:', e.message);
      }
    }

    await send({
      type: 'complete',
      score,
      moreCount,
      city,
      prominenceRank,
      publicId: auditId ? publicId : null,
      auditId,
      allFindings,
      topFindings: shown,
      matched,
      mismatch,
      screenshot,
      isHealthcare: detectHealthcareNiche(url, businessName, placeTypes),
      hadWebsite: !!effectiveUrl,
    });

  } catch (e) {
    console.error('runAudit threw:', e.message);
    await send({ type: 'error', message: 'Something went wrong running that check. Try again in a moment.' });
  }
}

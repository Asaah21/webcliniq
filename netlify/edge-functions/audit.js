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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY') || Deno.env.get('PAGESPEED_API_KEY');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const SITE_URL = (Deno.env.get('SITE_URL') || 'https://webcliniq.com').replace(/\/$/, '');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function buildVerdict(sorted) {
  const flagged = sorted.filter((f) => f.severity !== 'clear');
  if (!flagged.length) return "Nothing urgent. A closer look found a few smaller things worth tightening.";
  if (flagged[0].verdictOverride) return flagged[0].verdictOverride;
  const phrase = (f) => f.verdictPhrase || f.title.toLowerCase();
  if (flagged.length === 1) return `Start with ${phrase(flagged[0])}.`;
  return `Start with ${phrase(flagged[0])}, then ${phrase(flagged[1])}.`;
}

// A short, honest line that turns the bare number into context. Uses the real
// spread of past scores once there's enough of it; otherwise says what it means.
async function getScoreContext(score, hadWebsite) {
  const fallback = hadWebsite
    ? 'Scored on your Google listing and your website.'
    : 'Scored on your Google listing alone. A website would be checked too.';
  if (!supabase) return fallback;
  try {
    const { data } = await supabase.from('audits').select('health_score').not('health_score', 'is', null).limit(500);
    const scores = (data || []).map((r) => r.health_score).filter((n) => typeof n === 'number').sort((a, b) => a - b);
    if (scores.length < 15) return fallback;
    const median = scores[Math.floor(scores.length / 2)];
    if (score >= median) return `Better than most. Half the practices checked so far score below ${median}.`;
    return `Half the practices checked so far score above ${median}.`;
  } catch (e) {
    return fallback;
  }
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
  const clean = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  return clean(url1) === clean(url2);
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
    if (!res.ok) throw new Error(`PSI HTTP ${res.status}`);
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
        if (rawMsg.includes('failed_document_request') || rawMsg.includes('err_connection') || rawMsg.includes('dns')) text = "That website couldn't be reached. Double-check the address is correct and the site is live.";
        else if (rawMsg.includes('timeout')) text = 'That site took too long to respond, so the check couldn\'t finish.';
        console.error('PSI failed for', targetUrl, JSON.stringify(data).slice(0, 400));
        findings.push({ key: 'site-check', domain: 'website', severity: 'medium', title: 'Website check', value: 'incomplete', consequence: text });
      }
      findings.push(httpsFinding);
      return { findings, screenshot: null };
    }

    const lh = data.lighthouseResult;
    const A = lh.audits || {};
    const perfScore = Math.round((lh.categories.performance?.score || 0) * 100);
    const seoScore = Math.round((lh.categories.seo?.score || 0) * 100);
    const a11yScore = lh.categories.accessibility ? Math.round((lh.categories.accessibility.score || 0) * 100) : null;
    const crawlable = A['is-crawlable'];
    const screenshot = (A['final-screenshot'] && A['final-screenshot'].details && A['final-screenshot'].details.data) || null;
    const lcpSecs = A['largest-contentful-paint'] && A['largest-contentful-paint'].numericValue
      ? (A['largest-contentful-paint'].numericValue / 1000).toFixed(1) : null;

    if (crawlable && crawlable.score === 0) {
      findings.push({ key: 'crawlable', domain: 'website', severity: 'critical', title: 'Hidden from Google', value: 'blocking Google', consequence: 'Your site is telling Google not to list it. It may not appear in search at all.', fix: 'Crawlability fix', verdictPhrase: 'the pages hidden from Google' });
    }

    if (perfScore < 70) {
      findings.push({ key: 'phone-speed', domain: 'website', severity: perfScore < 45 ? 'high' : 'medium', bump: perfScore < 45 ? 10 : 0, title: 'Mobile load speed', value: lcpSecs ? `${lcpSecs}s to load` : `${perfScore}/100`, benchmark: "patients bounce past ~3s", consequence: 'Slow enough that visitors may leave before it loads.', fix: 'Speed Fix', verdictPhrase: 'your phone-site speed' });
    } else {
      findings.push({ key: 'phone-speed', domain: 'website', severity: 'clear', title: 'Mobile load speed', value: lcpSecs ? `${lcpSecs}s` : `${perfScore}/100` });
    }

    // The single biggest, most concrete speed cause — a number, not a grade.
    const opp = biggestSpeedOpportunity(A);
    if (opp && perfScore < 90) findings.push(opp);

    if (seoScore < 80) {
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

/* ---------- Website: one homepage fetch, parsed ---------- */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BOOKING_WIDGETS = /(calendly\.com|acuityscheduling|acuity\.com|nexhealth|zocdoc|squarespace-scheduling|setmore|simplybook|localmed|yapi|solutionreach|doctible|weave|dentrixascend|adit\.com)/i;
const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'threads.net'];

// WhatsApp alone does not count as a social media presence.
function checkSocialMedia(html, findings) {
  const hasSocial = SOCIAL_DOMAINS.some((domain) => html.includes(domain));
  if (!hasSocial) {
    findings.push({ key: 'social-media', domain: 'website', severity: 'medium', title: 'Social media presence', value: 'none linked', consequence: 'No social media linked from your site. Many patients check it to see whether a practice is active before they book.', fix: 'Social media setup' });
  }
}

async function runWebsiteContentCheck(targetUrl) {
  const findings = [];
  let html = '';
  let finalUrl = targetUrl;
  try {
    const res = await fetchWithTimeout(targetUrl, { timeout: 8000, redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' } });
    finalUrl = res.url || targetUrl;
    if (!res.ok) throw new Error(`homepage HTTP ${res.status}`);
    html = (await res.text()).slice(0, 400000); // cap — homepages that big are already a problem
  } catch (e) {
    // PageSpeed already reports an unreachable site; don't double up. Just skip.
    console.error('homepage fetch failed for', targetUrl, e.message);
    return { findings, html: '', finalUrl };
  }

  // Client-rendered sites (React/Next/Vue SPAs) serve a near-empty shell — the
  // real content never appears in this HTML. Parsing it would emit false
  // "not found" findings, so skip the content checks entirely.
  const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  const looksLikeSpaShell = visibleText.length < 800 && (/\bid\s*=\s*["'](root|__next|app|__nuxt)["']/i.test(html) || scriptCount > 12);
  if (looksLikeSpaShell) {
    console.error('homepage looks like a client-rendered shell, skipping content checks:', targetUrl);
    return { findings, html, finalUrl, spa: true };
  }

  checkContactFriction(html, findings);
  checkImprovementLayer(html, findings, finalUrl);
  checkSocialMedia(html, findings);
  await Promise.all([
    checkBrokenLinks(html, finalUrl, findings),
    checkKeyPages(html, finalUrl, findings),
  ]);

  return { findings, html, finalUrl };
}

// Homepage is not the whole site. Sample up to 4 internal pages and report the
// aggregate — "3 of 5 pages have no search description" is a concrete finding.
async function checkKeyPages(html, baseUrl, findings) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return; }
  const seen = new Set([baseUrl.replace(/#.*$/, '').replace(/\/$/, '')]);
  const urls = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && urls.length < 4) {
    let abs;
    try { abs = new URL(m[1], baseUrl); } catch { continue; }
    if (abs.origin !== origin) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx)$/i.test(abs.pathname)) continue;
    const norm = (abs.origin + abs.pathname).replace(/\/$/, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    urls.push(norm);
  }
  if (!urls.length) return;

  const pages = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetchWithTimeout(u, { timeout: 5000, redirect: 'follow', headers: { 'User-Agent': BROWSER_UA } });
      if (!r.ok) return null;
      const h = (await r.text()).slice(0, 120000);
      const md = (h.match(/<meta[^>]+name\s*=\s*["']?description["']?[^>]*content\s*=\s*["']([^"']{20,})["']/i) || [])[1];
      const h1 = /<h1[\s>]/i.test(h);
      const title = (h.match(/<title[^>]*>([^<]{5,})<\/title>/i) || [])[1];
      return { md: !!md, h1, title: !!title };
    } catch { return null; }
  }));
  const ok = pages.filter(Boolean);
  const total = ok.length + 1; // + homepage
  if (!ok.length) return;

  const noDesc = ok.filter((p) => !p.md).length;
  if (noDesc >= 1) {
    findings.push({ key: 'pages-meta', domain: 'website', severity: 'low', title: 'Search descriptions', value: `${noDesc} of ${total} pages missing`, consequence: 'Google shows a snippet under each page in results. Pages without one leave Google to pick the text itself.', fix: 'On-page SEO' });
  }
  const noH1 = ok.filter((p) => !p.h1).length;
  if (noH1 >= 1) {
    findings.push({ key: 'pages-h1', domain: 'website', severity: 'low', title: 'Page structure', value: `${noH1} of ${total} pages have no clear heading`, consequence: "A page with no main heading is harder for Google and skim-readers to place.", fix: 'On-page SEO' });
  }
}

function checkContactFriction(html, findings) {
  const hasTel = /href\s*=\s*["']tel:/i.test(html);
  if (!hasTel) {
    findings.push({ key: 'tap-to-call', domain: 'website', severity: 'medium', title: 'One-tap calling', value: 'missing', consequence: "Your phone number isn't a tappable link, so mobile patients have to copy it out by hand.", fix: 'Click-to-call', verdictPhrase: 'a tap-to-call number' });
  }

  const bookingRe = /book(?:ing)?\s*(?:online|now|a?\s*appointment|an?\s*appointment)?|request\s*(?:an?\s*)?appointment|schedule\s*(?:a\s*)?(?:visit|appointment)|make\s*an?\s*appointment/i;
  const hasBooking = bookingRe.test(html) || BOOKING_WIDGETS.test(html);
  if (!hasBooking) {
    findings.push({ key: 'booking-action', domain: 'website', severity: 'medium', title: 'Booking action', value: 'not found', consequence: "No clear 'Book' or 'Request appointment' button, so visitors have to hunt for how to book.", fix: 'Booking CTA', verdictPhrase: 'a clear booking button' });
  }

  const hasForm = /<form\b/i.test(html) || BOOKING_WIDGETS.test(html);
  if (!hasForm) {
    findings.push({ key: 'contact-form', domain: 'website', severity: 'low', title: 'Online enquiry form', value: 'none', consequence: 'Phone-only contact loses people who would rather type than call, and anyone getting in touch after hours.', fix: 'Form / booking embed' });
  }

  const hasAddress = /google\.com\/maps|maps\.google\.|<address\b|"@type"\s*:\s*"PostalAddress"|itemprop\s*=\s*["']address["']|<iframe[^>]+(?:google[^>]+maps|maps\.google)/i.test(html);
  if (!hasAddress) {
    findings.push({ key: 'address-map', domain: 'website', severity: 'low', title: 'Address on your website', value: 'not found', consequence: 'No address or embedded map on the homepage. That hurts local trust and how you rank nearby.', fix: 'Add address + map' });
  }
}

// Always-on improvement layer — legitimate, healthcare-relevant, sellable, and
// always something. All 'low' severity: they surface in "+N more", never move
// the score.
function checkImprovementLayer(html, findings, finalUrl) {
  const metaTag = (html.match(/<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*>/i) || [])[0] || '';
  const metaDesc = (metaTag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1]
    || (metaTag.match(/\bcontent\s*=\s*([^\s">]+)/i) || [])[1] || '';
  if (metaDesc.trim().length < 50) {
    findings.push({ key: 'meta-description', domain: 'website', severity: 'low', title: 'Google search preview', value: metaDesc ? 'too short' : 'missing', consequence: "Google shows a summary of your page in results. Yours is missing or too thin to be useful.", fix: 'On-page SEO' });
  }

  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withAlt = imgs.filter((t) => /\balt\s*=/i.test(t)).length;
  if (imgs.length >= 4 && withAlt / imgs.length < 0.6) {
    findings.push({ key: 'image-alt', domain: 'website', severity: 'low', title: 'Image descriptions', value: `${imgs.length - withAlt} of ${imgs.length} missing`, consequence: 'Images without alt text are invisible to screen readers and to Google image search.', fix: 'Accessibility pass' });
  }

  const haystack = html.toLowerCase();
  const hasPage = (re) => re.test(haystack);
  if (!hasPage(/new[\s-]?patient/)) {
    findings.push({ key: 'new-patients-page', domain: 'website', severity: 'low', title: 'New patients page', value: 'not found', consequence: "Nothing for a first-time patient: what to bring, what to expect, how to register.", fix: 'New-patients page' });
  }
  if (!hasPage(/our[\s-]?team|meet[\s-]the|our[\s-]?(?:doctors|dentists|physios|providers|staff)|\bbios?\b/)) {
    findings.push({ key: 'team-page', domain: 'website', severity: 'low', title: 'Meet the team page', value: 'not found', consequence: 'No practitioner bios. Patients choose partly on who they will see.', fix: 'Team page' });
  }
  if (!hasPage(/\bfaq\b|frequently\s+asked/)) {
    findings.push({ key: 'faq-page', domain: 'website', severity: 'low', title: 'Questions & answers page', value: 'not found', consequence: 'Common questions (insurance, first visit, hours) answered on the page cut down phone back-and-forth.', fix: 'FAQ page' });
  }
  if (!hasPage(/insurance|\bfees\b|payment\s+options|financing|self[\s-]?pay/)) {
    findings.push({ key: 'fees-info', domain: 'website', severity: 'low', title: 'Fees & payment info', value: 'not found', consequence: "Patients want cost and insurance answered before they call. Without it, many go elsewhere.", fix: 'Fees / insurance page' });
  }

  // Structured data — how Google reads your hours, address and services off the page.
  const ldBlocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const ld = ldBlocks.join(' ');
  const hasLocalSchema = /"@type"\s*:\s*"(MedicalBusiness|MedicalClinic|MedicalOrganization|Dentist|Physician|Hospital|LocalBusiness|Pharmacy|Optometric|DiagnosticLab)"/i.test(ld);
  if (!ldBlocks.length) {
    findings.push({ key: 'schema', domain: 'website', severity: 'medium', title: 'Practice info for Google', value: 'none', consequence: "Nothing tells Google your name, address, hours and services in a form it can read reliably, so it has to guess from the page.", fix: 'On-page SEO', verdictPhrase: 'your structured data' });
  } else if (!hasLocalSchema) {
    findings.push({ key: 'schema', domain: 'website', severity: 'low', title: 'Practice info for Google', value: 'no practice type', consequence: "Your page has some structured data, but nothing marking it as a healthcare practice, which is a missed signal for local search.", fix: 'On-page SEO' });
  }
}

// Only flags links that are genuinely dead (404 / 410 / DNS failure). Bot blocks
// (403 / 429) and servers that reject HEAD (405) are not counted.
async function checkBrokenLinks(html, baseUrl, findings) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return; }

  const hrefs = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && hrefs.size < 40) {
    const h = m[1].trim();
    if (!h || h.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(h)) continue;
    let abs;
    try { abs = new URL(h, baseUrl).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    hrefs.add(abs.split('#')[0]);
  }
  // Prefer same-origin links, then a few external, capped at 20.
  const links = [...hrefs].sort((a, b) => (a.startsWith(origin) ? 0 : 1) - (b.startsWith(origin) ? 0 : 1)).slice(0, 20);
  if (!links.length) return;

  const results = await Promise.allSettled(links.map(async (link) => {
    try {
      const r = await fetchWithTimeout(link, { method: 'HEAD', timeout: 4000, redirect: 'follow', headers: { 'User-Agent': BROWSER_UA } });
      return { link, status: r.status };
    } catch (e) {
      return { link, status: e.name === 'AbortError' ? 0 : -1 };
    }
  }));

  const dead = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v) => v && (v.status === 404 || v.status === 410 || v.status === -1));

  if (dead.length) {
    findings.push({ key: 'broken-links', domain: 'website', severity: 'medium', title: 'Broken links', value: `${dead.length} dead`, consequence: 'Links on your homepage lead nowhere, so patients hit dead ends.', fix: 'Link cleanup', verdictPhrase: 'the broken links' });
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

// Phone extraction for a NAP (name-address-phone) match. A `tel:` link is an
// intentional, high-confidence signal — prefer it. Only fall back to scanning
// visible text (never scripts/styles/markup, which hide analytics IDs, JSON-LD
// fields, etc.), and even then require something phone-shaped: 7-15 digits,
// not immediately preceded by a currency symbol (a price, not a number).
function extractPhoneFromHtml(html) {
  const telMatch = html.match(/href\s*=\s*["']tel:([^"']+)["']/i);
  if (telMatch) {
    const digits = telMatch[1].replace(/\D/g, '');
    if (digits.length >= 7) return digits;
  }

  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const candidates = visible.match(/[$£€]?\s*\+?\d[\d\s\-().]{6,18}\d/g) || [];
  for (const c of candidates) {
    if (/^[$£€]/.test(c.trim())) continue; // a price, not a phone number
    const digits = c.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) return digits;
  }
  return null;
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

async function runGooglePlacesCheck(targetQuery, apiKey, contentHtmlPromise) {
  const findings = [];
  if (!apiKey) return { findings, website: null, found: false, types: [] };

  try {
    const cleanQuery = targetQuery.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0].trim();
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
    // together, still parallel to PageSpeed. The homepage-content promise is
    // already in flight from the caller (or already resolved) — awaiting it
    // here costs nothing extra beyond whatever time it still needs.
    const [details, nearbyStats, city, prominenceRank, contentCheck] = await Promise.all([
      placeId ? getPlaceDetails(placeId, apiKey) : Promise.resolve({}),
      (location && nearbyType) ? getNearbyReviewStats(location, nearbyType, placeId, apiKey) : Promise.resolve(null),
      location ? getCityFromCoords(location.lat, location.lng, apiKey) : Promise.resolve(null),
      (location && nearbyType && placeId) ? getProminenceRank(location, nearbyType, placeId, apiKey) : Promise.resolve(null),
      contentHtmlPromise || Promise.resolve(null),
    ]);
    const contentHtml = contentCheck && contentCheck.html ? contentCheck.html : null;
    const website = details.website || null;
    const hoursSet = !!(details.openingHours && (details.openingHours.weekday_text || details.openingHours.periods));
    const reviewAgeDays = details.newestReviewDays ?? null;
    const nearbyMedian = nearbyStats ? nearbyStats.median : null;
    const nearbyTop3 = nearbyStats && nearbyStats.top3 && nearbyStats.top3.length ? nearbyStats.top3 : null;

    // The listing itself says the practice is closed — outranks everything else.
    if (details.businessStatus === 'CLOSED_PERMANENTLY' || details.businessStatus === 'CLOSED_TEMPORARILY') {
      const perm = details.businessStatus === 'CLOSED_PERMANENTLY';
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

    if (!hoursSet) {
      findings.push({ key: 'listing-hours', domain: 'listing', severity: 'medium', title: 'Opening hours on Google', value: 'not set', consequence: "Patients can't tell if you're open right now.", fix: 'Profile fill', verdictPhrase: 'your missing listing hours' });
    }

    if (!details.phone) {
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

    const photoCount = details.photoCount || (candidate.photos ? candidate.photos.length : 0);
    if (!photoCount) {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'medium', title: 'Listing photos', value: 'none', consequence: 'A listing with no photos looks abandoned, so patients scroll past to one that has them.', fix: 'Photo set' });
    } else if (photoCount < 6) {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'medium', title: 'Listing photos', value: `${photoCount} photo${photoCount === 1 ? '' : 's'}`, consequence: 'A handful of photos is thin next to practices with a full set of the space and team.', fix: 'Photo set' });
    } else {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'clear', title: 'Listing photos', value: `${photoCount} photos` });
    }

    // NAP (name-address-phone) consistency — only checkable once we actually
    // have both numbers; silently skipped otherwise (e.g. name-only path,
    // before the discovered site's homepage has been fetched).
    if (details.phone && contentHtml) {
      const gbpPhone = normalisePhone(details.phone);
      const sitePhone = normalisePhone(extractPhoneFromHtml(contentHtml));
      if (sitePhone && gbpPhone && sitePhone !== gbpPhone) {
        findings.push({ key: 'nap-consistency', domain: 'listing', severity: 'high', title: 'Phone number mismatch', value: 'Google vs website differ', consequence: "Your phone number on Google doesn't match your website. Google uses consistent details as a trust signal in local rankings, so a mismatch can count against you.", fix: 'NAP correction' });
      }
    }

    if (!details.description) {
      findings.push({ key: 'gbp-description', domain: 'listing', severity: 'medium', title: 'Google profile description', value: 'not written', consequence: "No description on your Google profile. This is space to tell patients what you treat and why to choose you, and it's quick to fill in.", fix: 'Profile fill' });
    }

    const practiceTypeLabel = TYPE_LABELS[nearbyType] || 'healthcare practices';
    if (nearbyType && placeId) {
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
      prominenceRank,
      nearbyTop3,
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
    const fields = 'website,opening_hours,reviews,formatted_phone_number,business_status,editorial_summary,photos';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&reviews_sort=newest&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    if (data.status !== 'OK') {
      console.error('Place Details error:', data.status, data.error_message || '');
      return {};
    }
    const r = data.result || {};
    const times = (r.reviews || []).map((x) => x.time).filter(Boolean);
    return {
      website: r.website || null,
      openingHours: r.opening_hours || null,
      newestReviewDays: times.length ? Math.round((Date.now() / 1000 - Math.max(...times)) / 86400) : null,
      phone: r.formatted_phone_number || null,
      businessStatus: r.business_status || null,
      description: (r.editorial_summary && r.editorial_summary.overview) || null,
      photoCount: Array.isArray(r.photos) ? r.photos.length : 0,
    };
  } catch (e) {
    console.error('Place Details failed:', e.message);
    return {};
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
// distance. 1-indexed; null means outside the top 20 returned.
async function getProminenceRank(location, type, ownPlaceId, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&rankby=prominence&type=${encodeURIComponent(type)}&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    const results = data.results || [];
    const position = results.findIndex((r) => r.place_id === ownPlaceId);
    return position === -1 ? null : position + 1;
  } catch (e) {
    console.error('Prominence rank check failed:', e.message);
    return null;
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
  runAudit(request, send).finally(() => writer.close());

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
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

  const { value } = payload;
  if (!value || typeof value !== 'string') {
    await send({ type: 'error', message: 'Please enter a business name or website.' });
    return;
  }

  const clientIp = request.headers.get('x-nf-client-connection-ip')
    || request.headers.get('client-ip') || '0.0.0.0';

  // Rate limit check (Supabase) before sending any events
  if (supabase) {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await supabase.from('audits')
        .select('*', { count: 'exact', head: true })
        .eq('ip_address', clientIp)
        .gte('created_at', oneHourAgo);
      if (count && count >= 5) {
        await send({ type: 'error', message: "You've run a few checks already. Give it a bit, then try again, or message me directly." });
        return;
      }
    } catch (e) {
      console.error('Rate limit check failed:', e.message);
    }
  }

  // Activate panel immediately
  await send({ type: 'searching' });

  const { url, businessName } = parseInput(value);
  const placesTarget = businessName || url;

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

  try {
    if (url) {
      // URL PATH: Places + PageSpeed + Content all start in parallel
      const placesPromise = placesTarget ? runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY, null) : Promise.resolve(null);
      const contentPromise = runWebsiteContentCheck(url);
      const speedPromise = runPageSpeedCheck(url, GOOGLE_API_KEY, 18000);

      // Send events as each resolves — order-independent
      placesPromise.then(async (r) => {
        if (!r) return;
        listingFindings = r.findings || [];
        placeTypes = r.types || [];
        city = r.city || null;
        prominenceRank = r.prominenceRank ?? null;
        nearbyTop3 = r.nearbyTop3 || null;
        if (r.found) {
          matched = { name: r.name, website: effectiveUrl };
          await send({ type: 'match', name: r.name, website: effectiveUrl });
          if (r.website && !urlsMatch(url, r.website)) {
            mismatch = "The website you entered doesn't match what's on this Google profile.";
          }
        }
        await send({ type: 'listing', findings: listingFindings });
      });

      contentPromise.then(async (r) => {
        if (!r) return;
        contentFindings = r.findings || [];
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
        ? await runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY, null)
        : null;

      if (listingResult && listingResult.found) {
        matched = { name: listingResult.name, website: listingResult.website };
        effectiveUrl = listingResult.website || null;
        placeTypes = listingResult.types || [];
        city = listingResult.city || null;
        prominenceRank = listingResult.prominenceRank ?? null;
        nearbyTop3 = listingResult.nearbyTop3 || null;
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
          const contentPromise = runWebsiteContentCheck(effectiveUrl);
          const speedPromise = runPageSpeedCheck(effectiveUrl, GOOGLE_API_KEY, 15000);

          // Send as each resolves
          contentPromise.then(async (r) => {
            if (!r) return;
            contentFindings = r.findings || [];
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

      if (!effectiveUrl) {
        listingFindings.push({
          key: 'no-website', domain: 'website', severity: 'critical',
          title: 'No website', value: 'none anywhere',
          consequence: 'Every patient who finds you on Google has nowhere to go to see what you treat, check whether you are a fit, or book.',
          fix: 'Starter site', verdictOverride: 'The biggest gap: no website to send patients to.'
        });
      }
    }

    // Merge and sort all findings
    const raw = [...listingFindings, ...contentFindings, ...speedFindings];
    const allFindings = sortFindings(raw).map(withAliases);
    let score = computeScore(allFindings);
    if (!effectiveUrl) score = Math.min(score, 45);

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
        if (sharp && typeof sharp === 'string') f.consequence = sharp;
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
    const publicId = crypto.randomUUID().slice(0, 8);

    // Save to Supabase
    let auditId = null;
    if (supabase) {
      try {
        const { data: row, error } = await supabase.from('audits').insert({
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
        }).select('id').single();
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
      publicId,
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

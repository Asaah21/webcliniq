// ============================================
// WebCliniQ — /.netlify/functions/audit
// ------------------------------------------
// Real checks, no simulated data. Accepts one
// input field that may contain a business name,
// a website, or both (comma-separated) — parses
// it and runs whichever checks apply:
//  - Website: PageSpeed Insights (speed/SEO),
//    plus a crawlability read pulled from
//    Lighthouse's own is-crawlable audit
//  - Business name: Places Text Search, read
//    deeply (reviews, hours, photos, category),
//    plus a Place Details lookup — but only when
//    a website was also given — to confirm the
//    website actually belongs to that listing
//
// Requires Netlify env vars:
//    GOOGLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Each check degrades gracefully (skips, or shows
// a plain-language note) if its config is missing
// or the check fails — never fakes data, and never
// surfaces raw API/error text to the visitor.
//
// Supabase `leads` table needs these columns for
// the fields this file writes:
//    business_name text, website text,
//    action_summary text, findings jsonb,
//    input_value text, input_type text,
//    source text, ip text, created_at timestamptz default now()
// ============================================

// WebCliniQ serves healthcare businesses broadly — not just dental.
// No tier here; every type in this list gets the same treatment.
const HEALTHCARE_TYPES = [
  'dentist', 'doctor', 'hospital', 'health', 'physiotherapist',
  'pharmacy', 'veterinary_care', 'medical_lab', 'wellness_center', 'spa',
];

function looksLikeUrl(str) {
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/.*)?$/i.test(str.trim());
}

// Input can be "Business Name", "example.com", or "Business Name, example.com".
function parseInput(raw) {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  let businessName = null;
  let websiteUrl = null;
  parts.forEach(p => {
    if (looksLikeUrl(p)) websiteUrl = p;
    else businessName = p;
  });
  return { businessName, websiteUrl };
}

function normalizeDomain(url) {
  if (!url) return null;
  let d = url.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  return d || null;
}

// Returns true when the domains look related, or when we simply can't
// tell (missing data) — a missing signal should never read as a mismatch.
function domainsRelated(domainA, domainB) {
  if (!domainA || !domainB) return true;
  if (domainA === domainB) return true;
  return domainA.endsWith('.' + domainB) || domainB.endsWith('.' + domainA);
}

// Turns a PageSpeed failure into something a visitor can actually act on.
// Never passes Google's raw error text through.
function friendlyWebsiteError(psiData) {
  const raw = ((psiData.error && psiData.error.message) || '').toLowerCase();
  if (raw.includes('failed_document_request') || raw.includes('err_connection') ||
      raw.includes('err_name_not_resolved') || raw.includes('dns')) {
    return "We couldn't reach that website. Double-check the address is correct and the site is live.";
  }
  if (raw.includes('timeout') || raw.includes('timed out')) {
    return "That site took too long to respond, so we couldn't finish the check.";
  }
  if (raw.includes('invalid') && raw.includes('url')) {
    return "That doesn't look like a valid website address — double-check it and try again.";
  }
  return "We couldn't fully check that website right now.";
}

// Logged once at cold start, not per-request — tells you in the Netlify
// function logs immediately if an env var is simply missing, which is
// the single most common cause of "nothing in the database."
function checkSupabaseConfig() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Supabase not configured: missing', !SUPABASE_URL ? 'SUPABASE_URL' : '', !SUPABASE_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY' : '');
    return false;
  }
  return true;
}
checkSupabaseConfig();

async function hasRecentCheck(raw) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?input_value=eq.${encodeURIComponent(raw)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) {
      console.error('hasRecentCheck failed:', res.status, await res.text());
      return false;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error('hasRecentCheck threw:', err.message);
    return false;
  }
}

async function logLead({ raw, businessName, websiteUrl, findings, actionSummary, ip }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        input_value: raw,
        input_type: websiteUrl && businessName ? 'both' : websiteUrl ? 'url' : 'business_name',
        business_name: businessName || null,
        website: websiteUrl || null,
        action_summary: actionSummary,
        findings,
        source: 'homepage_audit',
        ip, // requires an `ip` text column on the leads table
      }),
    });
    if (!res.ok) {
      // Most common causes: missing column on the `leads` table, RLS policy
      // blocking the insert, or SUPABASE_SERVICE_KEY being the anon key
      // instead of the service_role key. The response body usually says which.
      console.error('logLead insert failed:', res.status, await res.text());
    }
  } catch (err) {
    // Lead logging must never break the user-facing result, but it should
    // always leave a trace in the function logs.
    console.error('logLead threw:', err.message);
  }
}

// Short-burst abuse guard: caps how many *different* audits one visitor
// can trigger in a 15-minute window to two — enough for "check one thing,
// then add the other field," not enough to hammer the Google API quota.
// Requires the `ip` column above.
async function tooManyRequestsFromIp(ip) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ip || ip === 'unknown') return false;
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${encodeURIComponent(since)}&select=id`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) {
      console.error('tooManyRequestsFromIp failed:', res.status, await res.text());
      return false;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length >= 2;
  } catch (err) {
    console.error('tooManyRequestsFromIp threw:', err.message);
    return false;
  }
}

async function checkWebsite(websiteUrl, findings) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  const normalizedUrl = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;

  try {
    const psiUrl =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(normalizedUrl)}&strategy=mobile` +
      `&category=performance&category=seo&category=accessibility&category=best-practices` +
      `&key=${API_KEY}`;
    const psiRes = await fetch(psiUrl);
    const psiData = await psiRes.json();

    if (psiData.lighthouseResult && psiData.lighthouseResult.categories) {
      const cats = psiData.lighthouseResult.categories;
      // Only compute + surface what's actually sold right now (Speed Fix +
      // being found on Google). Accessibility and best-practices are real
      // scores but not part of the pitch — keep computing them quietly
      // (cheap, same API call) for an internal record, but don't push them
      // into visitor-facing findings.
      const scores = {
        performance: Math.round((cats.performance?.score || 0) * 100),
        seo: Math.round((cats.seo?.score || 0) * 100),
        accessibility: Math.round((cats.accessibility?.score || 0) * 100),
        bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
      };
      findings.push({ flag: scores.performance < 70 ? 'warn' : 'ok', priority: 2,
        text: `How fast your site loads: ${scores.performance}/100${scores.performance < 70 ? ' — slow enough that visitors may leave before it loads.' : '.'}` });
      findings.push({ flag: scores.seo < 80 ? 'warn' : 'ok', priority: 3,
        text: `How easy you are to find on Google: ${scores.seo}/100${scores.seo < 80 ? ' — missing some basics that help you show up in search.' : '.'}` });

      let crawlableBlocked = false;
      const crawlable = psiData.lighthouseResult.audits && psiData.lighthouseResult.audits['is-crawlable'];
      if (crawlable && crawlable.score !== null) {
        if (crawlable.score === 1) {
          findings.push({ flag: 'ok', priority: 3, text: 'Nothing is blocking Google from finding this page.' });
        } else {
          findings.push({ flag: 'warn', priority: 1, text: "This page is blocking Google from finding it — it may not show up in search at all." });
          crawlableBlocked = true;
        }
      }

      return { scores, crawlableBlocked };
    } else {
      console.error('PSI failed for', normalizedUrl, JSON.stringify(psiData));
      findings.push({ flag: 'warn', priority: 1, text: friendlyWebsiteError(psiData) });
      return { scores: null, crawlableBlocked: null };
    }
  } catch (err) {
    findings.push({ flag: 'warn', priority: 1, text: `We couldn't reach ${normalizedUrl} to run a check.` });
    return { scores: null, crawlableBlocked: null };
  }
}

// Loose guardrail: does the top Places result plausibly match what was typed?
// Places Text Search can return a same-named business in the wrong city, or an
// unrelated top hit for a generic name. This doesn't block anything — it just
// downgrades confidence so a stranger's review count isn't stated as this lead's.
function nameLooksLikeMatch(typed, found) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const typedWords = norm(typed);
  const foundWords = new Set(norm(found));
  const overlap = typedWords.filter(w => foundWords.has(w)).length;
  return overlap >= Math.max(1, Math.ceil(typedWords.length * 0.5));
}

// Only called when a website was also given, so this extra API call only
// happens when there's actually something to compare it against.
async function getListedWebsite(placeId) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=website&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.result && data.result.website) || null;
  } catch {
    return null;
  }
}

async function checkBusiness(businessName, findings, websiteUrl) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  if (businessName.trim().length < 2) {
    findings.push({ flag: 'warn', priority: 1, text: 'That business name looks too short to search — try the full name.' });
    return { info: null, mismatch: null };
  }
  try {
    const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(businessName)}&key=${API_KEY}`;
    const placesRes = await fetch(placesUrl);
    const placesData = await placesRes.json();
    const top = placesData.results && placesData.results[0];

    if (top && !nameLooksLikeMatch(businessName, top.name)) {
      findings.push({ flag: 'warn', priority: 1,
        text: `Closest Google match was "${top.name}". If that's not you, try adding your city or full name.` });
      return { info: null, mismatch: null };
    }

    if (top) {
      const types = top.types || [];
      const isHealthcare = types.some(t => HEALTHCARE_TYPES.includes(t));
      const info = {
        name: top.name,
        rating: top.rating || null,
        totalRatings: top.user_ratings_total || 0,
        address: top.formatted_address || null,
        hasPhotos: Array.isArray(top.photos) && top.photos.length > 0,
        hasHours: !!top.opening_hours,
        isHealthcare,
      };

      // Confirm the given website actually belongs to this listing —
      // only when there's a website to check and Google has one on file.
      // No signal either way is never treated as a mismatch.
      let mismatch = null;
      if (websiteUrl && top.place_id) {
        const listedWebsite = await getListedWebsite(top.place_id);
        if (listedWebsite) {
          const listedDomain = normalizeDomain(listedWebsite);
          const typedDomain = normalizeDomain(websiteUrl);
          if (!domainsRelated(listedDomain, typedDomain)) {
            mismatch = "The website you entered doesn't match what's listed on this Google profile. Double-check you've got the right one.";
          }
        }
      }

      findings.push({ flag: (!info.totalRatings || info.totalRatings < 5) ? 'warn' : 'ok', priority: 1,
        text: info.totalRatings
          ? `${info.totalRatings} review${info.totalRatings === 1 ? '' : 's'} at ${info.rating || '—'}★ on Google — ${info.totalRatings < 5 ? "people compare you on reviews before anything else." : 'a solid base.'}`
          : 'Your Google listing has no reviews yet.' });

      if (!info.hasHours) findings.push({ flag: 'warn', priority: 2, text: "No hours listed on your Google listing — people can't tell if you're open right now." });
      if (!info.hasPhotos) findings.push({ flag: 'warn', priority: 3, text: 'No photos on your Google listing — listings with photos get more clicks.' });
      if (!isHealthcare && types.length) findings.push({ flag: 'warn', priority: 6,
        text: "Heads up — this doesn't look like a healthcare listing on Google. We're built for healthcare, so results may be less tuned for you, but here's what we found anyway." });

      return { info, mismatch };
    } else {
      findings.push({ flag: 'warn', priority: 1, text: 'No Google listing found under this name — that alone is likely costing you patients.' });
      return { info: null, mismatch: null };
    }
  } catch (err) {
    findings.push({ flag: 'warn', priority: 1, text: "Couldn't check your Google listing right now. Try again shortly." });
    return { info: null, mismatch: null };
  }
}

// Internal-only, for follow-up — never shown to the visitor. Built from
// the structured signals rather than parsed from finding text, so it
// stays accurate even as the wording above changes.
function buildActionSummary({ siteScores, crawlableBlocked, placeInfo }) {
  const needs = [];
  if (crawlableBlocked) needs.push('blocked from Google indexing');
  if (siteScores && siteScores.performance < 70) needs.push('slow site speed');
  if (siteScores && siteScores.seo < 80) needs.push('SEO basics missing');
  if (placeInfo === null) needs.push('no Google listing found');
  if (placeInfo) {
    if (!placeInfo.totalRatings || placeInfo.totalRatings < 5) needs.push('needs more reviews');
    if (!placeInfo.hasHours) needs.push('missing hours');
    if (!placeInfo.hasPhotos) needs.push('missing photos');
  }
  return needs.length ? needs.join(', ') : 'no urgent issues found';
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const API_KEY = process.env.GOOGLE_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'The audit backend isn\'t configured yet — add GOOGLE_API_KEY as a Netlify environment variable.' }) };
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request.' }) };
  }

  const raw = (input.value || '').trim();
  if (!raw) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No business name or website provided.' }) };
  }

  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();

  if (await tooManyRequestsFromIp(ip)) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        softStop: true,
        message: "You've run a couple of checks already. Give it a few minutes, then try again.",
      }),
    };
  }

  if (await hasRecentCheck(raw)) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        findings: [{ flag: 'ok', priority: 1, text: "You already checked this in the last 24 hours. We'll follow up directly rather than repeat it." }],
        alreadyChecked: true,
      }),
    };
  }

  const { businessName, websiteUrl } = parseInput(raw);
  const findings = [];
  let siteScores = null;
  let crawlableBlocked = null;
  let placeInfo = null;
  let mismatch = null;

  if (websiteUrl) {
    const siteResult = await checkWebsite(websiteUrl, findings);
    siteScores = siteResult.scores;
    crawlableBlocked = siteResult.crawlableBlocked;
  }
  if (businessName) {
    const businessResult = await checkBusiness(businessName, findings, websiteUrl);
    placeInfo = businessResult.info;
    mismatch = businessResult.mismatch;
  }
  if (!websiteUrl) findings.push({ flag: 'warn', priority: 2, text: 'No website yet — add one for a speed and visibility check too.' });

  findings.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));

  const actionSummary = buildActionSummary({ siteScores, crawlableBlocked, placeInfo });

  await logLead({ raw, businessName, websiteUrl, findings, actionSummary, ip });

  return {
    statusCode: 200,
    body: JSON.stringify({ findings, siteScores, placeInfo, mismatch, hadWebsite: !!websiteUrl, hadBusinessName: !!businessName }),
  };
};

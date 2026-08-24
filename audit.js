// ============================================
// WebCliniQ — /.netlify/functions/audit
// ------------------------------------------
// Real checks, no simulated data. Accepts one
// input field that may contain a business name,
// a website, or both (comma-separated) — parses
// it and runs whichever checks apply:
//  - Website: PageSpeed Insights (speed/SEO/
//    accessibility/best-practices), plus a
//    crawlability read pulled from Lighthouse's
//    own is-crawlable audit — no separate
//    indexing API needed
//  - Business name: Places API Text Search, read
//    deeply (reviews, hours, photos, category)
//
// Requires Netlify env vars:
//    GOOGLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Each check degrades gracefully (skips, or shows
// a clear error) if its config is missing — never
// fakes data.
// ============================================

// DENTAL_TYPES are the primary niche; OTHER_HEALTH_TYPES are still fine leads
// (WebCliniQ shouldn't turn away a physio or clinic that finds the audit), just
// not who the site's marketing is written for.
const DENTAL_TYPES = ['dentist'];
const OTHER_HEALTH_TYPES = [
  'doctor', 'hospital', 'health', 'physiotherapist',
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
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function logLead({ raw, businessName, websiteUrl, findings, ip }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
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
        findings,
        source: 'homepage_audit',
        ip, // requires an `ip` text column on the leads table
      }),
    });
  } catch (err) {
    // Lead logging must never break the user-facing result.
  }
}

// Cheap abuse guard: caps how many *different* audits one visitor can trigger
// per hour. Each audit call costs you real Google API quota, so this matters
// more than it looks like it does. Requires the `ip` column above.
async function tooManyRequestsFromIp(ip) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ip || ip === 'unknown') return false;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${encodeURIComponent(since)}&select=id`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await res.json();
    return Array.isArray(rows) && rows.length >= 5; // 5 audits/hour per visitor
  } catch {
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
      // Only compute + surface what you actually sell right now (Speed Fix + being
      // found on Google). Accessibility and best-practices are real scores but not
      // a service on the homepage — showing them invites "can you fix this too?"
      // for things that aren't part of the pitch yet. Keep computing them quietly
      // (cheap, same API call) in case you want them for an internal record, but
      // don't push them into the findings a lead sees.
      const scores = {
        performance: Math.round((cats.performance?.score || 0) * 100),
        seo: Math.round((cats.seo?.score || 0) * 100),
        accessibility: Math.round((cats.accessibility?.score || 0) * 100),
        bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
      };
      findings.push({ flag: scores.performance < 70 ? 'warn' : 'ok', priority: 2,
        text: `Mobile speed score: ${scores.performance}/100${scores.performance < 70 ? ' — slow enough to lose visitors before the page loads.' : '.'}` });
      // SEO fundamentals stays — it's the throughline between "found on Google" (GBP)
      // and "found on Google" (search), so it supports the pitch instead of expanding it.
      findings.push({ flag: scores.seo < 80 ? 'warn' : 'ok', priority: 3,
        text: `SEO fundamentals score: ${scores.seo}/100${scores.seo < 80 ? ' — likely missing basics like meta descriptions or proper headings.' : '.'}` });

      const crawlable = psiData.lighthouseResult.audits && psiData.lighthouseResult.audits['is-crawlable'];
      if (crawlable && crawlable.score !== null) {
        if (crawlable.score === 1) {
          findings.push({ flag: 'ok', priority: 3, text: 'Nothing is blocking Google from indexing this page.' });
        } else {
          findings.push({ flag: 'warn', priority: 1, text: 'This page is actively blocking Google from indexing it — it may not show up in search at all.' });
        }
      }

      return scores;
    } else {
      const psiErrorMsg = psiData.error && psiData.error.message ? psiData.error.message : null;
      console.error('PSI failed for', normalizedUrl, JSON.stringify(psiData));
      findings.push({ flag: 'warn', priority: 1,
        text: psiErrorMsg ? `Couldn't analyze ${normalizedUrl} — Google's check said: ${psiErrorMsg}` : `Couldn't fully analyze ${normalizedUrl} — double-check the URL, or the site may be blocking automated checks.` });
      return null;
    }
  } catch (err) {
    findings.push({ flag: 'warn', priority: 1, text: `Couldn't reach ${normalizedUrl} to run a check.` });
    return null;
  }
}

// Loose guardrail: does the top Places result plausibly match what was typed?
// Places Text Search can return a same-named business in the wrong city, or an
// unrelated top hit for a generic name. This doesn't block anything — it just
// downgrades confidence in the finding text so you're not stating a stranger's
// review count as this lead's own.
function nameLooksLikeMatch(typed, found) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const typedWords = norm(typed);
  const foundWords = new Set(norm(found));
  const overlap = typedWords.filter(w => foundWords.has(w)).length;
  return overlap >= Math.max(1, Math.ceil(typedWords.length * 0.5));
}

async function checkBusiness(businessName, findings) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  if (businessName.trim().length < 2) {
    findings.push({ flag: 'warn', priority: 1, text: 'That business name looks too short to search — try the full practice name.' });
    return null;
  }
  try {
    const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(businessName)}&key=${API_KEY}`;
    const placesRes = await fetch(placesUrl);
    const placesData = await placesRes.json();
    const top = placesData.results && placesData.results[0];

    if (top && !nameLooksLikeMatch(businessName, top.name)) {
      findings.push({ flag: 'warn', priority: 1,
        text: `Closest Google match was "${top.name}" — if that's not your practice, try adding your city or the full registered name.` });
      return null;
    }

    if (top) {
      const types = top.types || [];
      const isDental = types.some(t => DENTAL_TYPES.includes(t));
      const isOtherHealth = types.some(t => OTHER_HEALTH_TYPES.includes(t));
      const info = {
        name: top.name,
        rating: top.rating || null,
        totalRatings: top.user_ratings_total || 0,
        address: top.formatted_address || null,
        hasPhotos: Array.isArray(top.photos) && top.photos.length > 0,
        hasHours: !!top.opening_hours,
        isDental,
      };

      findings.push({ flag: (!info.totalRatings || info.totalRatings < 5) ? 'warn' : 'ok', priority: 1,
        text: info.totalRatings
          ? `${info.totalRatings} review${info.totalRatings === 1 ? '' : 's'} at ${info.rating || '—'}★ on Google — ${info.totalRatings < 5 ? 'patients compare practices on reviews before anything else.' : 'a solid base.'}`
          : 'Google Business Profile found, but with no reviews yet.' });

      if (!info.hasHours) findings.push({ flag: 'warn', priority: 2, text: 'No hours listed on your Google Business Profile — patients can\'t tell if you\'re open right now.' });
      if (!info.hasPhotos) findings.push({ flag: 'warn', priority: 3, text: 'No photos on your Google Business Profile — listings with photos get significantly more clicks.' });
      // Not a hard block — WebCliniQ markets to dental practices specifically,
      // but a physio, clinic, or wellness business finding the tool is still a
      // fine lead. This just sets expectations rather than pretending the fixes
      // were written with them in mind.
      if (!isDental && isOtherHealth) findings.push({ flag: 'warn', priority: 6,
        text: 'Heads up: our fixes are tuned specifically for dental practices, but we\'re happy to take a look at your listing either way.' });
      if (!isDental && !isOtherHealth && types.length) findings.push({ flag: 'warn', priority: 6,
        text: 'Heads up: this doesn\'t look like a dental or healthcare business on Google. We focus on dental practices, so results may not be as tuned to your kind of business.' });
      return info;
    } else {
      findings.push({ flag: 'warn', priority: 1, text: 'No Google Business Profile found under this name — that alone is likely the biggest gap for getting found by patients.' });
      return null;
    }
  } catch (err) {
    findings.push({ flag: 'warn', priority: 1, text: 'Couldn\'t check Google Business Profile status for your practice right now.' });
    return null;
  }
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
        findings: [{ flag: 'ok', priority: 1, text: 'You\'ve run a few checks already — message us directly and we\'ll go through the rest with you.' }],
        alreadyChecked: true,
      }),
    };
  }

  if (await hasRecentCheck(raw)) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        findings: [{ flag: 'ok', priority: 1, text: 'You already ran a check on this in the last 24 hours — we\'ll follow up directly rather than repeat it.' }],
        alreadyChecked: true,
      }),
    };
  }

  const { businessName, websiteUrl } = parseInput(raw);
  const findings = [];
  let siteScores = null;
  let placeInfo = null;

  if (websiteUrl) siteScores = await checkWebsite(websiteUrl, findings);
  if (businessName) placeInfo = await checkBusiness(businessName, findings);
  if (!websiteUrl) findings.push({ flag: 'warn', priority: 2, text: 'No website was provided — add one (separated by a comma) to check your speed and how easy you are to find on Google too.' });

  findings.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));

  await logLead({ raw, businessName, websiteUrl, findings, ip });

  return {
    statusCode: 200,
    body: JSON.stringify({ findings, siteScores, placeInfo, hadWebsite: !!websiteUrl, hadBusinessName: !!businessName }),
  };
};

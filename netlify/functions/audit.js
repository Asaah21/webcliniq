// ============================================
// WebCliniQ — /.netlify/functions/audit
// ------------------------------------------
// Real checks, no simulated data. Accepts one
// input field that may contain a business name,
// a website, or both (comma-separated) — parses
// it and runs whichever checks apply:
//  - Website: PageSpeed Insights (speed/SEO/
//    accessibility/best-practices) + a basic
//    Google-indexing check via Custom Search API
//  - Business name: Places API Text Search, read
//    deeply (reviews, hours, photos, category)
//
// Requires Netlify env vars:
//    GOOGLE_API_KEY, GOOGLE_CSE_ID,
//    SUPABASE_URL, SUPABASE_SERVICE_KEY
// Each check degrades gracefully (skips, or shows
// a clear error) if its config is missing — never
// fakes data.
// ============================================

const MEDICAL_TYPES = [
  'doctor', 'dentist', 'hospital', 'health', 'physiotherapist',
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

async function logLead({ raw, businessName, websiteUrl, findings }) {
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
      }),
    });
  } catch (err) {
    // Lead logging must never break the user-facing result.
  }
}

async function checkIndexed(normalizedUrl) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  const CSE_ID = process.env.GOOGLE_CSE_ID;
  if (!CSE_ID) return null;
  try {
    const domain = normalizedUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CSE_ID}&q=${encodeURIComponent('site:' + domain)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error('CSE failed for', domain, JSON.stringify(data.error));
      return null;
    }
    const total = data.searchInformation ? parseInt(data.searchInformation.totalResults || '0', 10) : 0;
    return total > 0;
  } catch (err) {
    return null;
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
      const scores = {
        performance: Math.round((cats.performance?.score || 0) * 100),
        seo: Math.round((cats.seo?.score || 0) * 100),
        accessibility: Math.round((cats.accessibility?.score || 0) * 100),
        bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
      };
      findings.push({ flag: scores.performance < 70 ? 'warn' : 'ok', priority: 2,
        text: `Mobile speed score: ${scores.performance}/100${scores.performance < 70 ? ' — slow enough to lose visitors before the page loads.' : '.'}` });
      findings.push({ flag: scores.seo < 80 ? 'warn' : 'ok', priority: 3,
        text: `SEO fundamentals score: ${scores.seo}/100${scores.seo < 80 ? ' — likely missing basics like meta descriptions or proper headings.' : '.'}` });
      findings.push({ flag: scores.accessibility < 80 ? 'warn' : 'ok', priority: 4,
        text: `Accessibility score: ${scores.accessibility}/100${scores.accessibility < 80 ? ' — some patients may struggle to use the site.' : '.'}` });
      findings.push({ flag: scores.bestPractices < 80 ? 'warn' : 'ok', priority: 5,
        text: `Technical best-practices score: ${scores.bestPractices}/100.` });

      const indexed = await checkIndexed(normalizedUrl);
      if (indexed === true) {
        findings.push({ flag: 'ok', priority: 3, text: 'Your site is indexed by Google — it can actually be found in search.' });
      } else if (indexed === false) {
        findings.push({ flag: 'warn', priority: 1, text: 'Your site doesn\'t appear to be indexed by Google at all — patients can\'t find you in search, period.' });
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

async function checkBusiness(businessName, findings) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  try {
    const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(businessName)}&key=${API_KEY}`;
    const placesRes = await fetch(placesUrl);
    const placesData = await placesRes.json();
    const top = placesData.results && placesData.results[0];

    if (top) {
      const types = top.types || [];
      const isMedical = types.some(t => MEDICAL_TYPES.includes(t));
      const info = {
        name: top.name,
        rating: top.rating || null,
        totalRatings: top.user_ratings_total || 0,
        address: top.formatted_address || null,
        hasPhotos: Array.isArray(top.photos) && top.photos.length > 0,
        hasHours: !!top.opening_hours,
        isMedical,
      };

      findings.push({ flag: (!info.totalRatings || info.totalRatings < 5) ? 'warn' : 'ok', priority: 1,
        text: info.totalRatings
          ? `${info.totalRatings} review${info.totalRatings === 1 ? '' : 's'} at ${info.rating || '—'}★ on Google — ${info.totalRatings < 5 ? 'patients compare clinics on reviews before anything else.' : 'a solid base.'}`
          : 'Google Business Profile found, but with no reviews yet.' });

      if (!info.hasHours) findings.push({ flag: 'warn', priority: 2, text: 'No hours listed on your Google Business Profile — patients can\'t tell if you\'re open right now.' });
      if (!info.hasPhotos) findings.push({ flag: 'warn', priority: 3, text: 'No photos on your Google Business Profile — listings with photos get significantly more clicks.' });
      if (!isMedical && types.length) findings.push({ flag: 'warn', priority: 4, text: 'This listing isn\'t categorized as a medical or dental business on Google — that\'s worth fixing, though not urgent.' });
      return info;
    } else {
      findings.push({ flag: 'warn', priority: 1, text: 'No Google Business Profile found under this name — that alone is likely the biggest gap for getting found by patients.' });
      return null;
    }
  } catch (err) {
    findings.push({ flag: 'warn', priority: 1, text: 'Couldn\'t check Google Business Profile status right now.' });
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
  if (!websiteUrl) findings.push({ flag: 'warn', priority: 2, text: 'No website was provided — add one (separated by a comma) for a speed and SEO read too.' });

  findings.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));

  await logLead({ raw, businessName, websiteUrl, findings });

  return { statusCode: 200, body: JSON.stringify({ findings, siteScores, placeInfo }) };
};

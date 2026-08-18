// ============================================
// WebCliniQ — /.netlify/functions/audit
// ------------------------------------------
// Real checks, no simulated data:
//  - Website: Google PageSpeed Insights API
//    (performance, SEO, accessibility, best
//    practices — all from one Lighthouse run)
//  - Google presence: Places API Text Search
//
// Requires a Netlify environment variable:
//    GOOGLE_API_KEY
// with "PageSpeed Insights API" and "Places API"
// both enabled on the same Google Cloud project.
// Without it, this returns a clear error instead
// of fake results.
// ============================================

function looksLikeUrl(str) {
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/.*)?$/i.test(str.trim());
}

// Logs every completed audit as a lead — independent of the separate
// "email me this report" opt-in form. Fails silently if Supabase isn't
// configured yet, or if the insert errors, so lead logging never breaks
// the user-facing audit result.
async function logLead({ raw, isUrl, findings }) {
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
        input_type: isUrl ? 'url' : 'business_name',
        findings,
        source: 'homepage_audit',
      }),
    });
  } catch (err) {
    // Intentionally swallowed — see comment above.
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const API_KEY = process.env.GOOGLE_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'The audit backend isn\'t configured yet — add GOOGLE_API_KEY as a Netlify environment variable.',
      }),
    };
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request.' }) };
  }

  const raw = (input.value || input.businessName || input.websiteUrl || '').trim();
  if (!raw) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No business name or website provided.' }) };
  }

  const findings = [];
  let siteScores = null;
  let placeInfo = null;
  const isUrl = looksLikeUrl(raw);

  if (isUrl) {
    const normalizedUrl = raw.startsWith('http') ? raw : `https://${raw}`;
    try {
      const psiUrl =
        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
        `?url=${encodeURIComponent(normalizedUrl)}` +
        `&strategy=mobile` +
        `&category=performance&category=seo&category=accessibility&category=best-practices` +
        `&key=${API_KEY}`;
      const psiRes = await fetch(psiUrl);
      const psiData = await psiRes.json();

      if (psiData.lighthouseResult && psiData.lighthouseResult.categories) {
        const cats = psiData.lighthouseResult.categories;
        siteScores = {
          performance: Math.round((cats.performance?.score || 0) * 100),
          seo: Math.round((cats.seo?.score || 0) * 100),
          accessibility: Math.round((cats.accessibility?.score || 0) * 100),
          bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
        };

        findings.push({
          flag: siteScores.performance < 70 ? 'warn' : 'ok',
          text: `Mobile speed score: ${siteScores.performance}/100${siteScores.performance < 70 ? ' — slow enough to lose visitors before the page loads.' : '.'}`,
        });
        findings.push({
          flag: siteScores.seo < 80 ? 'warn' : 'ok',
          text: `SEO fundamentals score: ${siteScores.seo}/100${siteScores.seo < 80 ? ' — likely missing basics like meta descriptions or proper headings.' : '.'}`,
        });
        findings.push({
          flag: siteScores.accessibility < 80 ? 'warn' : 'ok',
          text: `Accessibility score: ${siteScores.accessibility}/100${siteScores.accessibility < 80 ? ' — some patients may struggle to use the site.' : '.'}`,
        });
        findings.push({
          flag: siteScores.bestPractices < 80 ? 'warn' : 'ok',
          text: `Technical best-practices score: ${siteScores.bestPractices}/100.`,
        });
      } else {
        findings.push({
          flag: 'warn',
          text: `Couldn't fully analyze ${normalizedUrl} — double-check the URL, or the site may be blocking automated checks.`,
        });
      }
    } catch (err) {
      findings.push({ flag: 'warn', text: `Couldn't reach ${normalizedUrl} to run a check.` });
    }
  } else {
    try {
      const placesUrl =
        `https://maps.googleapis.com/maps/api/place/textsearch/json` +
        `?query=${encodeURIComponent(raw)}&key=${API_KEY}`;
      const placesRes = await fetch(placesUrl);
      const placesData = await placesRes.json();
      const top = placesData.results && placesData.results[0];

      if (top) {
        placeInfo = {
          name: top.name,
          rating: top.rating || null,
          totalRatings: top.user_ratings_total || 0,
          address: top.formatted_address || null,
        };
        findings.push({
          flag: !placeInfo.totalRatings || placeInfo.totalRatings < 5 ? 'warn' : 'ok',
          text: placeInfo.totalRatings
            ? `Google Business Profile found — ${placeInfo.totalRatings} review${placeInfo.totalRatings === 1 ? '' : 's'} at ${placeInfo.rating || '—'}★.`
            : 'Google Business Profile found, but with no reviews yet.',
        });
      } else {
        findings.push({
          flag: 'warn',
          text: 'No Google Business Profile found under this name — that alone is likely the biggest gap.',
        });
      }
    } catch (err) {
      findings.push({ flag: 'warn', text: 'Couldn\'t check Google Business Profile status right now.' });
    }
    findings.push({ flag: 'warn', text: 'No website was provided — enter a URL as well to get a speed and SEO read.' });
  }

  await logLead({ raw, isUrl, findings });

  return {
    statusCode: 200,
    body: JSON.stringify({ findings, siteScores, placeInfo }),
  };
};

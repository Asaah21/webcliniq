// ============================================
// WebCliniQ — /.netlify/functions/audit
// ------------------------------------------
// Real checks, no simulated data, no invented
// statistics. Accepts one input field that may
// contain a business name, a website, or both
// (comma-separated).
//
// Two actions:
//   (default)        run the audit
//   capture_email     email the already-computed
//                     results to the visitor via
//                     Resend — no re-checking, the
//                     frontend sends back what it
//                     already has.
//
// Requires Netlify env vars:
//    GOOGLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//    RESEND_API_KEY   — email capture is skipped
//                        gracefully (visitor told
//                        plainly) if this is missing
//    FROM_EMAIL        — defaults to Resend's shared
//                        test sender if not set
//
// Supabase tables used:
//   audits       ip_address, search_query, health_score,
//                top_findings, all_findings, had_website,
//                had_business_name, created_at
//   audit_leads  email, search_query, health_score,
//                findings, created_at
// ============================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'WebCliniQ <onboarding@resend.dev>';

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabase) console.error('Supabase not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
if (!RESEND_API_KEY) console.warn('RESEND_API_KEY not set — email capture will tell visitors plainly rather than pretend to send.');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request.' }) };
  }

  const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || '0.0.0.0';

  // --- EMAIL CAPTURE: send the already-computed results, don't re-check ---
  if (payload.action === 'capture_email') {
    return await handleEmailCapture(payload);
  }

  // --- AUDIT REQUEST ---
  try {
    const { value } = payload;
    if (!value || typeof value !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a business name or website.' }) };
    }

    if (supabase) {
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count } = await supabase.from('audits').select('*', { count: 'exact', head: true })
          .eq('ip_address', clientIp).gte('created_at', oneHourAgo);
        if (count && count >= 5) {
          return { statusCode: 200, body: JSON.stringify({ softStop: true, message: "You've run a few checks already. Give it a bit, then try again, or message us directly." }) };
        }
      } catch (dbErr) {
        console.error('Rate-limit check failed:', dbErr.message);
      }
    }

    const { url, businessName } = parseInput(value);
    const findings = [];
    let placeTypes = [];
    let mismatch = null;

    const placesTarget = businessName || url;
    let placesMatched = false;

    // Run both checks concurrently. PageSpeed's lab run alone can take ~8s and
    // Netlify caps synchronous functions at 10s, so they must not run back-to-back.
    const [pageSpeedResults, placesResults] = await Promise.all([
      url ? runPageSpeedCheck(url, GOOGLE_API_KEY) : Promise.resolve(null),
      placesTarget ? runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY) : Promise.resolve(null),
    ]);

    if (pageSpeedResults) findings.push(...pageSpeedResults.findings);

    if (placesResults) {
      findings.push(...placesResults.findings);
      placesMatched = placesResults.found;
      placeTypes = placesResults.types || [];

      if (url && placesResults.website && !urlsMatch(url, placesResults.website)) {
        mismatch = "The website you entered doesn't match what's listed on this Google profile. Double-check you've got the right one.";
      }
    }

    if (!url) findings.push({ category: 'Website', flag: 'warn', text: 'No website given yet. Add one for a speed and visibility check too.' });

    const isHealthcare = detectHealthcareNiche(url, businessName, placeTypes);
    findings.sort((a, b) => (a.flag === 'warn' ? -1 : 1));

    const healthScore = calculateHealthScore(findings);
    const letterGrade = calculateLetterGrade(healthScore);
    const topFindings = findings.slice(0, 3);
    const additionalCount = Math.max(0, findings.length - 3);

    if (supabase) {
      try {
        const { error } = await supabase.from('audits').insert({
          ip_address: clientIp,
          search_query: value,
          health_score: healthScore,
          top_findings: topFindings,
          all_findings: findings,
          had_website: !!url,
          had_business_name: !!businessName || placesMatched,
        });
        if (error) console.error('audits insert failed:', error.message);
      } catch (insertErr) {
        console.error('audits insert threw:', insertErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        healthScore,
        letterGrade,
        topFindings,
        additionalCount,
        allFindings: findings,
        isHealthcare,
        hadWebsite: !!url,
        hadBusinessName: !!businessName || placesMatched,
        mismatch,
        alreadyChecked: false,
      }),
    };
  } catch (err) {
    console.error('audit handler threw:', err.message);
    return { statusCode: 200, body: JSON.stringify({ findings: [{ flag: 'warn', text: "Something went wrong running that check. Try again in a moment." }], healthScore: null, letterGrade: null, topFindings: [{ flag: 'warn', text: "Something went wrong running that check. Try again in a moment." }], additionalCount: 0, allFindings: [], hadWebsite: false, hadBusinessName: false, mismatch: null, alreadyChecked: false }) };
  }
};

/* ---------- Email capture ---------- */
async function handleEmailCapture(payload) {
  const { email, search_query, health_score, letter_grade, findings } = payload;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: "That doesn't look like a valid email address." }) };
  }

  if (!RESEND_API_KEY) {
    // Never claim success when nothing was actually sent.
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'not_configured', message: "Email delivery isn't set up yet — message us on WhatsApp instead and we'll send it directly." }) };
  }

  const html = buildResultsEmailHtml({ search_query, health_score, letter_grade, findings: findings || [] });

  try {
    const res = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        subject: `Your WebCliniQ results for ${search_query || 'your business'}`,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend send failed:', res.status, errText);
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'send_failed', message: "Couldn't send that right now — try WhatsApp instead." }) };
    }
  } catch (err) {
    console.error('Resend send threw:', err.message);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'send_failed', message: "Couldn't send that right now — try WhatsApp instead." }) };
  }

  if (supabase) {
    try {
      const { error } = await supabase.from('audit_leads').insert({
        email,
        search_query: search_query || null,
        health_score: health_score ?? null,
        findings: findings || [],
      });
      if (error) console.error('audit_leads insert failed:', error.message);
    } catch (insertErr) {
      console.error('audit_leads insert threw:', insertErr.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
}

function buildResultsEmailHtml({ search_query, health_score, letter_grade, findings }) {
  const rows = findings.map(f =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #DCE2EA;font-size:14px;color:${f.flag === 'warn' ? '#A8431F' : '#147A65'};font-family:monospace;white-space:nowrap;vertical-align:top;">${f.flag === 'warn' ? 'FLAG' : 'CLEAR'}</td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #DCE2EA;font-size:14px;color:#45566E;">${f.text}</td></tr>`
  ).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
    <div style="background:#12233D;padding:24px 28px;border-radius:10px 10px 0 0;">
      <span style="color:#fff;font-size:20px;font-weight:bold;">WebClini<span style="color:#6EC1FF;">Q</span></span>
    </div>
    <div style="padding:28px;border:1px solid #DCE2EA;border-top:none;border-radius:0 0 10px 10px;">
      <p style="color:#12233D;font-size:16px;margin:0 0 4px;">Your results for <strong>${search_query || 'your business'}</strong></p>
      ${health_score != null ? `<p style="color:#6B7890;font-size:13px;margin:0 0 20px;">Score: ${health_score}/100${letter_grade ? ` &middot; Grade ${letter_grade}` : ''}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="margin-top:24px;">
        <a href="https://wa.me/233538665715" style="display:inline-block;background:#12233D;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;">Message Us on WhatsApp</a>
      </p>
      <p style="color:#6B7890;font-size:12px;margin-top:24px;">You're receiving this because you asked WebCliniQ to email your audit results. support@webcliniq.com</p>
    </div>
  </div>`;
}

/* ---------- Helpers ---------- */
function parseInput(input) {
  const parts = input.split(',').map(s => s.trim());
  let url = null, businessName = null;
  const urlPattern = /(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/[^\s]*)?/;
  parts.forEach(part => {
    if (urlPattern.test(part)) { url = part.startsWith('http') ? part : `https://${part}`; }
    else if (part) { businessName = part; }
  });
  return { url, businessName };
}

function detectHealthcareNiche(url, businessName, types) {
  const HEALTHCARE_TYPES = ['dentist', 'doctor', 'hospital', 'health', 'physiotherapist', 'pharmacy', 'veterinary_care', 'medical_lab', 'wellness_center', 'spa'];
  if (types && types.some(t => HEALTHCARE_TYPES.includes(t))) return true;
  if (types && types.length) return false; // Google gave us a real category and it isn't healthcare
  // No category data at all (no Places match) — fall back to a soft keyword read rather than guessing "no"
  const keywords = ['clinic', 'dental', 'dentist', 'health', 'medical', 'doctor', 'physio', 'chiro', 'care', 'hospital', 'derma', 'therapy', 'nursing'];
  const content = `${url || ''} ${businessName || ''}`.toLowerCase();
  return keywords.some(kw => content.includes(kw));
}

// -12 per warning rather than -18, floor at 20 rather than 10 — a couple of
// minor flags shouldn't already read as a failing grade.
function calculateHealthScore(findings) {
  let score = 100;
  findings.forEach(f => { if (f.flag === 'warn') score -= 12; });
  return Math.max(20, Math.min(100, score));
}

function calculateLetterGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function urlsMatch(url1, url2) {
  const clean = u => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  return clean(url1) === clean(url2);
}

async function runPageSpeedCheck(targetUrl, apiKey) {
  const findings = [];
  const httpsFinding = targetUrl.startsWith('https://')
    ? { category: 'Trust', flag: 'ok', text: 'Your site uses a secure connection.' }
    : { category: 'Trust', flag: 'warn', text: "Your site isn't using a secure connection (HTTPS) — browsers flag this to visitors." };
  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&strategy=mobile&category=performance&category=seo${apiKey ? `&key=${apiKey}` : ''}`;
    // PSI's lab run is slow and highly variable (8-14s typical, longer for heavy
    // sites). Give it 18s; it runs alone on the clock (Places is parallel) and
    // Netlify's synchronous cap here is ~26s.
    const res = await fetchWithTimeout(endpoint, { timeout: 18000 });
    if (!res.ok) throw new Error(`PSI HTTP ${res.status}`);
    const data = await res.json();

    if (!data.lighthouseResult || !data.lighthouseResult.categories) {
      // The slow lab run didn't finish — fall back to Google's real-user field data if present.
      const field = data.loadingExperience && data.loadingExperience.metrics;
      const lcpMs = field && field.LARGEST_CONTENTFUL_PAINT_MS && field.LARGEST_CONTENTFUL_PAINT_MS.percentile;
      if (lcpMs) {
        const slow = lcpMs > 2500;
        findings.push({ category: 'Speed', flag: slow ? 'warn' : 'ok',
          text: `How fast your site loads for real visitors: ${(lcpMs / 1000).toFixed(1)}s to show the main content${slow ? ". Google's bar is 2.5s." : '.'}` });
      } else {
        const raw = ((data.error && data.error.message) || '').toLowerCase();
        let msg = "We couldn't fully check that website right now.";
        if (raw.includes('failed_document_request') || raw.includes('err_connection') || raw.includes('dns')) {
          msg = "We couldn't reach that website. Double-check the address is correct and the site is live.";
        } else if (raw.includes('timeout')) {
          msg = "That site took too long to respond, so we couldn't finish the check.";
        }
        console.error('PSI failed for', targetUrl, JSON.stringify(data).slice(0, 400));
        findings.push({ category: 'Website', flag: 'warn', text: msg });
      }
      findings.push(httpsFinding);
      return { findings };
    }

    const perfScore = Math.round((data.lighthouseResult.categories.performance?.score || 0) * 100);
    const seoScore = Math.round((data.lighthouseResult.categories.seo?.score || 0) * 100);

    if (perfScore < 70) findings.push({ category: 'Speed', flag: 'warn', text: `How fast your site loads: ${perfScore}/100. Slow enough that visitors may leave before it loads.` });
    else findings.push({ category: 'Speed', flag: 'ok', text: `How fast your site loads: ${perfScore}/100.` });

    if (seoScore < 80) findings.push({ category: 'Google Visibility', flag: 'warn', text: `How easy you are to find on Google: ${seoScore}/100. Missing some basics that help you show up in search.` });
    else findings.push({ category: 'Google Visibility', flag: 'ok', text: `How easy you are to find on Google: ${seoScore}/100.` });

    findings.push(httpsFinding);

    return { findings };
  } catch (e) {
    findings.push({ category: 'Website', flag: 'warn', text: e.name === 'AbortError'
      ? 'The deep speed check ran long on this site — the full report will include it.'
      : `We couldn't reach ${targetUrl} to run a check.` });
    findings.push(httpsFinding);
    return { findings };
  }
}

async function runGooglePlacesCheck(targetQuery, apiKey) {
  const findings = [];
  if (!apiKey) return { findings, website: null, found: false, types: [] };

  try {
    let cleanQuery = targetQuery.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(cleanQuery)}&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,website,types,opening_hours,photos&key=${apiKey}`;
    const res = await fetchWithTimeout(searchUrl);
    const data = await res.json();
    const candidate = data.candidates?.[0];

    if (!candidate) {
      findings.push({ category: 'Google Listing', flag: 'warn', text: 'No Google listing found under this name — that alone is likely costing you patients.' });
      return { findings, website: null, found: false, types: [] };
    }

    const rating = candidate.rating || 0, reviews = candidate.user_ratings_total || 0;

    if (!reviews || reviews < 5) findings.push({ category: 'Reviews', flag: 'warn', text: reviews ? `${reviews} review${reviews === 1 ? '' : 's'} at ${rating}★ on Google. People compare you on reviews before anything else.` : 'Your Google listing has no reviews yet.' });
    else findings.push({ category: 'Reviews', flag: 'ok', text: `${reviews} reviews at ${rating}★ on Google. A solid base.` });

    if (!candidate.opening_hours) findings.push({ category: 'Google Listing', flag: 'warn', text: "No hours listed on your Google listing — people can't tell if you're open right now." });
    if (!candidate.photos || !candidate.photos.length) findings.push({ category: 'Google Listing', flag: 'warn', text: 'No photos on your Google listing — listings with photos get more clicks.' });

    return { findings, website: candidate.website || null, found: true, types: candidate.types || [] };
  } catch (e) {
    findings.push({ category: 'Google Listing', flag: 'warn', text: "Couldn't check your Google listing right now. Try again shortly." });
    return { findings, website: null, found: false, types: [] };
  }
}

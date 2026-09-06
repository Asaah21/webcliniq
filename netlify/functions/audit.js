// ============================================
// WebCliniQ — /.netlify/functions/audit
// ------------------------------------------
// Real checks, no simulated data, no invented statistics. One input field that
// may hold a business name, a website, or both (comma-separated).
//
// Actions:
//   (default)      run the audit
//   capture_email  email the already-computed results via Resend (no re-check)
//
// Env: GOOGLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//      RESEND_API_KEY (optional — capture degrades honestly if missing)
//      FROM_EMAIL     (optional)
//
// --- Finding contract (Step 1) ---
// Every finding is:
//   key         stable machine id           e.g. 'reviews-vs-area'
//   domain      'listing' | 'website'       (breaks ties in the severity sort)
//   severity    critical|high|medium|low|clear
//   title       short human label           e.g. 'Reviews vs. your area'
//   value       the number/state (short)    e.g. '11'
//   benchmark   what it's measured against  e.g. 'area median 43'   (optional)
//   consequence plain "what this costs you" (optional)
//   fix         the sellable fix            e.g. 'Review system'    (optional)
//   bump        small +weight from the measured value              (optional)
//   verdictPhrase  phrasing for the one-line verdict               (optional)
// `flag`, `category`, `text` are added as back-compat aliases before returning.
// ============================================

const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

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

// Only critical/high move the score. medium/low are "things to tighten" — they
// surface in "+N more", but with the always-on improvement layer every practice
// has several, so counting them would peg every score at the floor.
function computeScore(findings) {
  let score = 100;
  for (const f of findings) {
    if (f.severity === 'critical') score -= 18;
    else if (f.severity === 'high') score -= 10;
  }
  return Math.max(20, Math.min(100, score));
}

function buildVerdict(sorted) {
  const flagged = sorted.filter((f) => f.severity !== 'clear');
  if (!flagged.length) return 'A solid baseline — just a few smaller things to tighten.';
  const phrase = (f) => f.verdictPhrase || f.title.toLowerCase();
  if (flagged.length === 1) return `Start with ${phrase(flagged[0])}.`;
  return `Start with ${phrase(flagged[0])}, then ${phrase(flagged[1])}.`;
}

// Back-compat: the current script.js reads .flag / .category / .text.
function withAliases(f) {
  const parts = [];
  if (f.value) parts.push(`${f.title}: ${f.value}${f.benchmark ? ` vs ${f.benchmark}` : ''}`);
  else parts.push(f.title);
  if (f.consequence) parts.push(f.consequence);
  return {
    ...f,
    flag: f.severity === 'clear' ? 'ok' : 'warn',
    category: f.title,
    text: parts.join(' — '),
  };
}

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

  if (payload.action === 'capture_email') {
    return await handleEmailCapture(payload);
  }

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
    const raw = [];
    let mismatch = null;

    const placesTarget = businessName || url;

    // PageSpeed's lab run runs alone on the clock (up to 18s); the Places branch
    // runs alongside it.
    const [siteResult, listingResult] = await Promise.all([
      url ? runPageSpeedCheck(url, GOOGLE_API_KEY) : Promise.resolve(null),
      placesTarget ? runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY) : Promise.resolve(null),
    ]);

    let screenshot = null;
    if (siteResult) {
      raw.push(...siteResult.findings);
      screenshot = siteResult.screenshot || null;
    }

    let placeTypes = [];
    let placesMatched = false;
    let matched = null;
    if (listingResult) {
      raw.push(...listingResult.findings);
      placesMatched = listingResult.found;
      placeTypes = listingResult.types || [];
      if (listingResult.found) {
        matched = { name: listingResult.name || null, website: listingResult.website || null, url: url || null };
      }
      if (url && listingResult.website && !urlsMatch(url, listingResult.website)) {
        mismatch = "The website you entered doesn't match what's listed on this Google profile. Double-check you've got the right one.";
      }
    }

    if (!url) {
      raw.push({
        key: 'no-website', domain: 'website', severity: 'high', title: 'Website',
        value: 'none given', consequence: 'Add one for a speed and visibility check too.',
        verdictPhrase: 'adding a website',
      });
    }

    const isHealthcare = detectHealthcareNiche(url, businessName, placeTypes);

    const findings = sortFindings(raw).map(withAliases);
    const score = computeScore(findings);
    const verdict = buildVerdict(findings);

    let shown = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').slice(0, 5);
    if (!shown.length) shown = findings.filter((f) => f.severity !== 'clear').slice(0, 3);
    const moreCount = Math.max(0, findings.filter((f) => f.severity !== 'clear').length - shown.length);

    const publicId = randomUUID().slice(0, 8); // stub — the /r/<id> page + DB column land in Step 3

    if (supabase) {
      try {
        const { error } = await supabase.from('audits').insert({
          ip_address: clientIp,
          search_query: value,
          health_score: score,
          top_findings: shown,
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
        // Step 1 contract
        publicId,
        score,
        verdict,
        findings,
        shownCount: shown.length,
        moreCount,
        screenshot,
        matched,
        isHealthcare,
        hadWebsite: !!url,
        hadListing: placesMatched,
        mismatch,
        alreadyChecked: false,
        // Back-compat aliases for the current frontend (removed once Step 2 lands)
        healthScore: score,
        letterGrade: null,
        topFindings: shown,
        additionalCount: moreCount,
        allFindings: findings,
        hadBusinessName: !!businessName || placesMatched,
      }),
    };
  } catch (err) {
    console.error('audit handler threw:', err.message);
    const fallback = [withAliases({ key: 'error', domain: 'website', severity: 'medium', title: 'Check', consequence: 'Something went wrong running that check. Try again in a moment.' })];
    return { statusCode: 200, body: JSON.stringify({ publicId: null, score: null, verdict: '', findings: fallback, shownCount: 1, moreCount: 0, screenshot: null, matched: null, isHealthcare: null, hadWebsite: false, hadListing: false, mismatch: null, alreadyChecked: false, healthScore: null, letterGrade: null, topFindings: fallback, additionalCount: 0, allFindings: fallback, hadBusinessName: false }) };
  }
};

/* ---------- Email capture ---------- */
async function handleEmailCapture(payload) {
  const { email, search_query, health_score, letter_grade, findings } = payload;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: "That doesn't look like a valid email address." }) };
  }

  if (!RESEND_API_KEY) {
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
  const rows = findings.map((f) =>
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
  const parts = input.split(',').map((s) => s.trim());
  let url = null, businessName = null;
  const urlPattern = /(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/[^\s]*)?/;
  parts.forEach((part) => {
    if (urlPattern.test(part)) { url = part.startsWith('http') ? part : `https://${part}`; }
    else if (part) { businessName = part; }
  });
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
async function runPageSpeedCheck(targetUrl, apiKey) {
  const findings = [];
  const isHttps = targetUrl.startsWith('https://');
  const httpsFinding = isHttps
    ? { key: 'secure-connection', domain: 'website', severity: 'clear', title: 'Secure connection', value: 'HTTPS' }
    : { key: 'secure-connection', domain: 'website', severity: 'critical', title: 'Secure connection', value: 'no HTTPS', consequence: "Browsers flag your site as 'Not secure' before a patient submits anything.", fix: 'SSL fix', verdictPhrase: 'the missing HTTPS' };

  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&strategy=mobile&category=performance&category=seo${apiKey ? `&key=${apiKey}` : ''}`;
    // PSI's lab run is slow and highly variable (8-14s typical, longer for heavy
    // sites). Give it 18s; it runs alone on the clock (Places is parallel) and
    // Netlify's synchronous cap here is ~26s.
    const res = await fetchWithTimeout(endpoint, { timeout: 18000 });
    if (!res.ok) throw new Error(`PSI HTTP ${res.status}`);
    const data = await res.json();

    if (!data.lighthouseResult || !data.lighthouseResult.categories) {
      const field = data.loadingExperience && data.loadingExperience.metrics;
      const lcpMs = field && field.LARGEST_CONTENTFUL_PAINT_MS && field.LARGEST_CONTENTFUL_PAINT_MS.percentile;
      if (lcpMs) {
        const secs = (lcpMs / 1000).toFixed(1);
        findings.push(lcpMs > 2500
          ? { key: 'phone-speed', domain: 'website', severity: 'high', title: 'Phone-site speed', value: `${secs}s`, benchmark: "Google's bar is 2.5s", consequence: 'Slow enough that many phone visitors leave before it loads.', fix: 'Speed Fix', verdictPhrase: 'your phone-site speed' }
          : { key: 'phone-speed', domain: 'website', severity: 'clear', title: 'Phone-site speed', value: `${secs}s (real-user)` });
      } else {
        const rawMsg = ((data.error && data.error.message) || '').toLowerCase();
        let text = "We couldn't fully check that website right now.";
        if (rawMsg.includes('failed_document_request') || rawMsg.includes('err_connection') || rawMsg.includes('dns')) text = "We couldn't reach that website. Double-check the address is correct and the site is live.";
        else if (rawMsg.includes('timeout')) text = 'That site took too long to respond, so we couldn\'t finish the check.';
        console.error('PSI failed for', targetUrl, JSON.stringify(data).slice(0, 400));
        findings.push({ key: 'site-check', domain: 'website', severity: 'medium', title: 'Website check', value: 'incomplete', consequence: text });
      }
      findings.push(httpsFinding);
      return { findings, screenshot: null };
    }

    const lh = data.lighthouseResult;
    const perfScore = Math.round((lh.categories.performance?.score || 0) * 100);
    const seoScore = Math.round((lh.categories.seo?.score || 0) * 100);
    const crawlable = lh.audits && lh.audits['is-crawlable'];
    const screenshot = (lh.audits && lh.audits['final-screenshot'] && lh.audits['final-screenshot'].details && lh.audits['final-screenshot'].details.data) || null;

    if (crawlable && crawlable.score === 0) {
      findings.push({ key: 'crawlable', domain: 'website', severity: 'critical', title: 'Search visibility', value: 'blocking Google', consequence: 'Your site is telling Google not to list it — it may not appear in search at all.', fix: 'Crawlability fix', verdictPhrase: 'the pages hidden from Google' });
    }

    if (perfScore < 70) {
      findings.push({ key: 'phone-speed', domain: 'website', severity: perfScore < 45 ? 'high' : 'medium', bump: perfScore < 45 ? 10 : 0, title: 'Phone-site speed', value: `${perfScore}/100`, consequence: 'Slow enough that visitors may leave before it loads.', fix: 'Speed Fix', verdictPhrase: 'your phone-site speed' });
    } else {
      findings.push({ key: 'phone-speed', domain: 'website', severity: 'clear', title: 'Phone-site speed', value: `${perfScore}/100` });
    }

    if (seoScore < 80) {
      findings.push({ key: 'search-basics', domain: 'website', severity: 'medium', title: 'Search basics', value: `${seoScore}/100`, consequence: 'Missing on-page basics that help patients find your specialty on Google.', fix: 'On-page SEO', verdictPhrase: 'your search basics' });
    } else {
      findings.push({ key: 'search-basics', domain: 'website', severity: 'clear', title: 'Search basics', value: `${seoScore}/100` });
    }

    findings.push(httpsFinding);
    return { findings, screenshot };
  } catch (e) {
    findings.push(e.name === 'AbortError'
      ? { key: 'phone-speed', domain: 'website', severity: 'low', title: 'Phone-site speed', value: 'not measured', consequence: 'The deep speed check ran long on this site — the full report will include it.' }
      : { key: 'site-reach', domain: 'website', severity: 'medium', title: 'Website check', value: 'unreachable', consequence: `We couldn't reach ${targetUrl} to run a check.` });
    findings.push(httpsFinding);
    return { findings, screenshot: null };
  }
}

/* ---------- Listing: Google Places ---------- */
async function runGooglePlacesCheck(targetQuery, apiKey) {
  const findings = [];
  if (!apiKey) return { findings, website: null, found: false, types: [] };

  try {
    const cleanQuery = targetQuery.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
    const fields = 'place_id,name,rating,user_ratings_total,website,types,opening_hours,photos,geometry';
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(cleanQuery)}&inputtype=textquery&fields=${fields}&key=${apiKey}`;
    const res = await fetchWithTimeout(searchUrl);
    const data = await res.json();
    const candidate = data.candidates && data.candidates[0];

    if (!candidate) {
      findings.push({ key: 'no-listing', domain: 'listing', severity: 'critical', title: 'Google Business Profile', value: 'not found', consequence: 'No Google listing found under this name — patients searching Maps for a nearby practice never see you.', fix: 'Listing setup + verification', verdictPhrase: 'your missing Google listing' });
      return { findings, website: null, found: false, types: [] };
    }

    const rating = candidate.rating || 0;
    const reviews = candidate.user_ratings_total || 0;

    if (!reviews) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'high', title: 'Google reviews', value: 'none yet', consequence: 'Patients compare practices on reviews before anything else.', fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (reviews < 5) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'medium', title: 'Google reviews', value: `${reviews} · ${rating}★`, consequence: 'Thin next to nearby practices — patients notice.', fix: 'Review system', verdictPhrase: 'your reviews' });
    } else {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'clear', title: 'Google reviews', value: `${reviews} · ${rating}★` });
    }

    if (!candidate.opening_hours) {
      findings.push({ key: 'listing-hours', domain: 'listing', severity: 'medium', title: 'Listing hours', value: 'not set', consequence: "Patients can't tell if you're open right now.", fix: 'Profile fill', verdictPhrase: 'your missing listing hours' });
    }
    if (!candidate.photos || !candidate.photos.length) {
      findings.push({ key: 'listing-photos', domain: 'listing', severity: 'low', title: 'Listing photos', value: 'none', consequence: 'Listings with photos get more clicks and calls.', fix: 'Photo set' });
    }

    return {
      findings,
      website: candidate.website || null,
      found: true,
      types: candidate.types || [],
      name: candidate.name || null,
      rating,
      reviews,
      placeId: candidate.place_id || null,
      location: (candidate.geometry && candidate.geometry.location) || null,
    };
  } catch (e) {
    findings.push({ key: 'listing-check', domain: 'listing', severity: 'medium', title: 'Google listing', value: 'not checked', consequence: "Couldn't check your Google listing right now. Try again shortly." });
    return { findings, website: null, found: false, types: [] };
  }
}

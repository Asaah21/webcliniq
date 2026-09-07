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

    // PageSpeed's lab run runs alone on the clock (up to 18s). The homepage
    // content scan and the Places branch run alongside it.
    const [siteResult, contentResult, listingResult] = await Promise.all([
      url ? runPageSpeedCheck(url, GOOGLE_API_KEY) : Promise.resolve(null),
      url ? runWebsiteContentCheck(url) : Promise.resolve(null),
      placesTarget ? runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY) : Promise.resolve(null),
    ]);

    let screenshot = null;
    if (siteResult) {
      raw.push(...siteResult.findings);
      screenshot = siteResult.screenshot || null;
    }
    if (contentResult) raw.push(...contentResult.findings);

    let placeTypes = [];
    let placesMatched = false;
    let matched = null;
    let placesStatus = null;
    if (listingResult) {
      placesStatus = listingResult._placesStatus || (listingResult.found ? 'OK' : null);
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
        _placesStatus: placesStatus, // temporary diagnostic — removed after Step 1
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

/* ---------- Website: one homepage fetch, parsed ---------- */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BOOKING_WIDGETS = /(calendly\.com|acuityscheduling|acuity\.com|nexhealth|zocdoc|squarespace-scheduling|setmore|simplybook|localmed|yapi|solutionreach|doctible|weave|dentrixascend|adit\.com)/i;

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
  await checkBrokenLinks(html, finalUrl, findings);

  return { findings, html, finalUrl };
}

function checkContactFriction(html, findings) {
  const hasTel = /href\s*=\s*["']tel:/i.test(html);
  if (!hasTel) {
    findings.push({ key: 'tap-to-call', domain: 'website', severity: 'medium', title: 'Tap-to-call', value: 'missing', consequence: "Your phone number isn't a tappable link — mobile patients have to copy it out by hand.", fix: 'Click-to-call', verdictPhrase: 'a tap-to-call number' });
  }

  const bookingRe = /book(?:ing)?\s*(?:online|now|a?\s*appointment|an?\s*appointment)?|request\s*(?:an?\s*)?appointment|schedule\s*(?:a\s*)?(?:visit|appointment)|make\s*an?\s*appointment/i;
  const hasBooking = bookingRe.test(html) || BOOKING_WIDGETS.test(html);
  if (!hasBooking) {
    findings.push({ key: 'booking-action', domain: 'website', severity: 'medium', title: 'Booking action', value: 'not found', consequence: "No clear 'Book' or 'Request appointment' action — visitors hunt for how to get in.", fix: 'Booking CTA', verdictPhrase: 'a clear booking button' });
  }

  const hasForm = /<form\b/i.test(html) || BOOKING_WIDGETS.test(html);
  if (!hasForm) {
    findings.push({ key: 'contact-form', domain: 'website', severity: 'low', title: 'Contact form', value: 'none', consequence: 'Phone-only contact — you lose people who would rather type than call, and after-hours enquiries.', fix: 'Form / booking embed' });
  }

  const hasAddress = /google\.com\/maps|maps\.google\.|<address\b|"@type"\s*:\s*"PostalAddress"|itemprop\s*=\s*["']address["']|<iframe[^>]+(?:google[^>]+maps|maps\.google)/i.test(html);
  if (!hasAddress) {
    findings.push({ key: 'address-map', domain: 'website', severity: 'low', title: 'Address on site', value: 'not found', consequence: 'No address or embedded map on the homepage — hurts local trust and how you rank nearby.', fix: 'Add address + map' });
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
    findings.push({ key: 'meta-description', domain: 'website', severity: 'low', title: 'Search description', value: metaDesc ? 'too short' : 'missing', consequence: "Google shows a summary of your page in results — yours is missing or too thin to be useful.", fix: 'On-page SEO' });
  }

  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withAlt = imgs.filter((t) => /\balt\s*=/i.test(t)).length;
  if (imgs.length >= 4 && withAlt / imgs.length < 0.6) {
    findings.push({ key: 'image-alt', domain: 'website', severity: 'low', title: 'Image alt text', value: `${imgs.length - withAlt} of ${imgs.length} missing`, consequence: 'Images without alt text are invisible to screen readers and to Google image search.', fix: 'Accessibility pass' });
  }

  const haystack = html.toLowerCase();
  const hasPage = (re) => re.test(haystack);
  if (!hasPage(/new[\s-]?patient/)) {
    findings.push({ key: 'new-patients-page', domain: 'website', severity: 'low', title: 'New-patients page', value: 'not found', consequence: "Nothing aimed at a first-time patient — what to bring, what to expect, how to register.", fix: 'New-patients page' });
  }
  if (!hasPage(/our[\s-]?team|meet[\s-]the|our[\s-]?(?:doctors|dentists|physios|providers|staff)|\bbios?\b/)) {
    findings.push({ key: 'team-page', domain: 'website', severity: 'low', title: 'Team / bios page', value: 'not found', consequence: 'No practitioner bios — patients pick a provider partly on who they will actually see.', fix: 'Team page' });
  }
  if (!hasPage(/\bfaq\b|frequently\s+asked/)) {
    findings.push({ key: 'faq-page', domain: 'website', severity: 'low', title: 'FAQ', value: 'not found', consequence: 'Common questions (insurance, first visit, hours) answered on the page cut down phone back-and-forth.', fix: 'FAQ page' });
  }
  if (!hasPage(/insurance|\bfees\b|payment\s+options|financing|self[\s-]?pay/)) {
    findings.push({ key: 'fees-info', domain: 'website', severity: 'low', title: 'Fees / insurance info', value: 'not found', consequence: "Patients want cost and insurance answered before they call — silence sends them elsewhere.", fix: 'Fees / insurance page' });
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
    findings.push({ key: 'broken-links', domain: 'website', severity: 'medium', title: 'Broken links', value: `${dead.length} dead`, consequence: 'Links on your homepage lead nowhere — patients hit dead ends and Google notices.', fix: 'Link cleanup', verdictPhrase: 'the broken links' });
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
    console.error('Places findplacefromtext status:', data.status, data.error_message || '', 'candidates:', (data.candidates || []).length);
    const candidate = data.candidates && data.candidates[0];

    if (!candidate) {
      findings.push({ key: 'no-listing', domain: 'listing', severity: 'critical', title: 'Google Business Profile', value: 'not found', consequence: 'No Google listing found under this name — patients searching Maps for a nearby practice never see you.', fix: 'Listing setup + verification', verdictPhrase: 'your missing Google listing' });
      return { findings, website: null, found: false, types: [], _placesStatus: data.status || 'NO_STATUS' };
    }

    const rating = candidate.rating || 0;
    const reviews = candidate.user_ratings_total || 0;
    const placeId = candidate.place_id || null;
    const location = (candidate.geometry && candidate.geometry.location) || null;
    const nearbyType = pickNearbyType(candidate.types);

    // Chained after the match, run together, still parallel to PageSpeed.
    const [reviewAgeDays, nearbyMedian] = await Promise.all([
      placeId ? getRecentReviewAgeDays(placeId, apiKey) : Promise.resolve(null),
      (location && nearbyType) ? getNearbyReviewMedian(location, nearbyType, placeId, apiKey) : Promise.resolve(null),
    ]);

    // One reviews finding, decided with the best data available.
    if (!reviews) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'high', title: 'Google reviews', value: 'none yet', consequence: 'Patients compare practices on reviews before anything else.', fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (nearbyMedian && nearbyMedian >= 10 && reviews < nearbyMedian * 0.5) {
      const far = reviews < nearbyMedian * 0.33;
      findings.push({ key: 'reviews', domain: 'listing', severity: far ? 'high' : 'medium', bump: far ? 10 : 0, title: 'Reviews vs. your area', value: `${reviews} · ${rating}★`, benchmark: `area median ${nearbyMedian}`, consequence: `Practices near you carry around ${nearbyMedian} reviews — patients compare and pick the bigger number.`, fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (reviews < 5) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'medium', title: 'Google reviews', value: `${reviews} · ${rating}★`, consequence: 'Thin next to nearby practices — patients notice.', fix: 'Review system', verdictPhrase: 'your reviews' });
    } else if (rating && rating < 4.3) {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'medium', title: 'Google rating', value: `${rating}★ · ${reviews} reviews`, benchmark: 'patients trust 4.3★+', consequence: 'Below the rating most patients will book from without a second look.', fix: 'Reputation repair + review flow', verdictPhrase: 'your rating' });
    } else {
      findings.push({ key: 'reviews', domain: 'listing', severity: 'clear', title: 'Google reviews', value: `${reviews} · ${rating}★` });
    }

    if (reviews && reviewAgeDays != null && reviewAgeDays > 183) {
      const months = Math.round(reviewAgeDays / 30);
      findings.push({ key: 'review-recency', domain: 'listing', severity: 'medium', title: 'Review recency', value: `newest is ~${months} mo old`, consequence: 'A listing with no recent reviews reads as a practice that has gone quiet — or closed.', fix: 'Review system', verdictPhrase: 'your stale reviews' });
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

// Places `type` values valid for a rankby=distance nearby search, healthcare only.
const NEARBY_TYPES = ['dentist', 'physiotherapist', 'doctor', 'hospital', 'pharmacy', 'veterinary_care', 'spa'];
function pickNearbyType(types) {
  if (!Array.isArray(types)) return null;
  return NEARBY_TYPES.find((t) => types.includes(t)) || null;
}

async function getRecentReviewAgeDays(placeId, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=reviews&reviews_sort=newest&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    const times = (data.result && data.result.reviews || []).map((r) => r.time).filter(Boolean);
    if (!times.length) return null;
    const newest = Math.max(...times); // unix seconds
    return Math.round((Date.now() / 1000 - newest) / 86400);
  } catch (e) {
    console.error('review recency check failed:', e.message);
    return null;
  }
}

async function getNearbyReviewMedian(location, type, ownPlaceId, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&rankby=distance&type=${encodeURIComponent(type)}&key=${apiKey}`;
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    const data = await res.json();
    const counts = (data.results || [])
      .filter((r) => r.place_id !== ownPlaceId && typeof r.user_ratings_total === 'number')
      .slice(0, 15)
      .map((r) => r.user_ratings_total)
      .sort((a, b) => a - b);
    if (counts.length < 4) return null; // not enough neighbours to be a real benchmark
    const mid = Math.floor(counts.length / 2);
    return counts.length % 2 ? counts[mid] : Math.round((counts[mid - 1] + counts[mid]) / 2);
  } catch (e) {
    console.error('nearby median check failed:', e.message);
    return null;
  }
}

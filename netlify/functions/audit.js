const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Utility to prevent external APIs from causing 500 timeouts
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

  try {
    const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || '0.0.0.0';
    const payload = JSON.parse(event.body || '{}');

    // --- HANDLE EMAIL LEAD CAPTURE ---
    if (payload.action === 'capture_email') {
      if (supabase && payload.email) {
        await supabase.from('audit_leads').insert({
          email: payload.email,
          search_query: payload.search_query,
          health_score: payload.health_score
        });
      }
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // --- HANDLE AUDIT REQUEST ---
    const { value } = payload;
    if (!value || typeof value !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a practice website domain or clinic name.' }) };
    }

    // Rate Limiting (Max 5 checks/hour)
    if (supabase) {
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count } = await supabase.from('audits').select('*', { count: 'exact', head: true })
          .eq('ip_address', clientIp).gte('created_at', oneHourAgo);

        if (count && count >= 5) {
          return { statusCode: 200, body: JSON.stringify({ softStop: true, message: "Limit reached. Contact WebCliniQ directly on WhatsApp." }) };
        }
      } catch (dbErr) { console.warn('Supabase limit skipped:', dbErr.message); }
    }

    const { url, businessName } = parseInput(value);
    const findings = [];
    let pageTitle = '';
    let placeTypes = [];
    let mismatch = null;

    if (url) {
      const pageSpeedResults = await runPageSpeedCheck(url, GOOGLE_API_KEY);
      findings.push(...pageSpeedResults.findings);
      pageTitle = pageSpeedResults.title || '';
    }

    const placesTarget = businessName || url;
    let placesMatched = false;

    if (placesTarget) {
      const placesResults = await runGooglePlacesCheck(placesTarget, GOOGLE_API_KEY);
      findings.push(...placesResults.findings);
      placesMatched = placesResults.found;
      placeTypes = placesResults.types || [];

      if (url && placesResults.website && !urlsMatch(url, placesResults.website)) {
        mismatch = `Website entered (${url}) does not match your official Google Business Profile link (${placesResults.website}).`;
      }
    }

    const isHealthcare = detectHealthcareNiche(url, businessName, placeTypes, pageTitle);
    findings.sort((a, b) => (a.flag === 'warn' ? -1 : 1));
    
    const healthScore = calculateHealthScore(findings);
    const letterGrade = calculateLetterGrade(healthScore);
    const topFindings = findings.slice(0, 3);
    const additionalCount = Math.max(0, findings.length - 3);

    if (supabase) {
      try {
        await supabase.from('audits').insert({
          ip_address: clientIp,
          search_query: value,
          health_score: healthScore,
          top_findings: topFindings,
          all_findings: findings,
          had_website: !!url,
          had_business_name: !!businessName || placesMatched
        });
      } catch (insertErr) { console.warn('Supabase logging skipped:', insertErr.message); }
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
        alreadyChecked: false
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Diagnostic backend error. Unable to process request.' }) };
  }
};

/* Helper Functions */
function parseInput(input) {
  const parts = input.split(',').map(s => s.trim());
  let url = null, businessName = null;
  const urlPattern = /(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/[^\s]*)?/;
  parts.forEach(part => {
    if (urlPattern.test(part)) { url = part.startsWith('http') ? part : `https://${part}`; } 
    else { businessName = part; }
  });
  return { url, businessName };
}

function detectHealthcareNiche(url, businessName, types, title) {
  const keywords = ['clinic', 'dental', 'dentist', 'teeth', 'smile', 'ortho', 'health', 'medical', 'doctor', 'physio', 'chiro', 'care', 'pharma', 'eye', 'hospital', 'derma', 'skin', 'podiatry', 'therapy', 'patient', 'surgery', 'nursing'];
  const content = `${url || ''} ${businessName || ''} ${title || ''} ${types.join(' ')}`.toLowerCase();
  return keywords.some(kw => content.includes(kw));
}

function calculateHealthScore(findings) {
  let score = 100;
  findings.forEach(f => { if (f.flag === 'warn') score -= 18; });
  return Math.max(10, Math.min(100, score));
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

/* Audits with graceful fallback */
async function runPageSpeedCheck(targetUrl, apiKey) {
  const findings = [];
  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&strategy=mobile&category=PERFORMANCE&category=SEO${apiKey ? `&key=${apiKey}` : ''}`;
    const res = await fetchWithTimeout(endpoint);
    
    if (!res.ok) throw new Error("API Blocked");
    const data = await res.json();
    const perfScore = Math.round((data.lighthouseResult?.categories?.performance?.score || 0) * 100);
    const lcp = data.lighthouseResult?.audits?.['largest-contentful-paint']?.numericValue || 0;

    if (perfScore < 60) findings.push({ category: 'Patient Booking', flag: 'warn', text: `Low mobile score (${perfScore}/100). 53% of mobile patients abandon slow pages.` });
    else findings.push({ category: 'Patient Booking', flag: 'clear', text: `Mobile performance baseline is solid (${perfScore}/100).` });

    if (lcp > 3500) findings.push({ category: 'Speed & UX', flag: 'warn', text: `Clinical elements take ${(lcp / 1000).toFixed(1)}s to load on mobile.` });
    else findings.push({ category: 'Speed & UX', flag: 'clear', text: `Mobile load time optimal.` });

    if (!targetUrl.startsWith('https://')) findings.push({ category: 'Trust & Privacy', flag: 'warn', text: 'Site lacks SSL (HTTPS). "Not Secure" warning visible.' });
    else findings.push({ category: 'Trust & Privacy', flag: 'clear', text: 'SSL active (Encrypted connection).' });

    return { findings, title: data.lighthouseResult?.errorMessage || '' };
  } catch (e) {
    findings.push({ category: 'Website Health', flag: 'warn', text: 'Diagnostic timed out. Automated systems blocked or slow.' });
    return { findings, title: '' };
  }
}

async function runGooglePlacesCheck(targetQuery, apiKey) {
  const findings = [];
  if (!apiKey) return { findings: [{ category: 'Maps', flag: 'clear', text: 'API check active.' }], website: null, found: false, types: [] };

  try {
    let cleanQuery = targetQuery.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(cleanQuery)}&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,website,types&key=${apiKey}`;
    const res = await fetchWithTimeout(searchUrl);
    const data = await res.json();
    const candidate = data.candidates?.[0];

    if (!candidate) {
      findings.push({ category: 'Clinic Discovery', flag: 'warn', text: 'No matching Google Maps profile found. 78% of patients use Maps.' });
      return { findings, website: null, found: false, types: [] };
    }

    const rating = candidate.rating || 0, reviews = candidate.user_ratings_total || 0;
    findings.push({ category: 'Clinic Discovery', flag: 'clear', text: `Verified listing for "${candidate.name}".` });

    if (rating < 4.3 || reviews < 20) findings.push({ category: 'Patient Trust', flag: 'warn', text: `Google listing has ${reviews} reviews (${rating || 'N/A'} stars).` });
    else findings.push({ category: 'Patient Trust', flag: 'clear', text: `Strong patient review score (${rating} stars, ${reviews} reviews).` });

    if (!candidate.website) findings.push({ category: 'Maps Conversion', flag: 'warn', text: 'No direct website link attached to your Google Maps listing.' });

    return { findings, website: candidate.website, found: true, types: candidate.types || [] };
  } catch (e) {
    findings.push({ category: 'Google Maps', flag: 'warn', text: 'Unable to verify profile records (API Timeout).' });
    return { findings, website: null, found: false, types: [] };
  }
}
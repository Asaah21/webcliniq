const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  try {
    const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || '0.0.0.0';
    const { value } = JSON.parse(event.body || '{}');

    if (!value || typeof value !== 'string') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Please enter a practice domain or clinic name.' })
      };
    }

    // Rate Limiting via Supabase (Max 5 checks / hour per IP)
    if (supabase) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from('audits')
        .select('*', { count: 'exact', head: true })
        .eq('ip_address', clientIp)
        .gte('created_at', oneHourAgo);

      if (count && count >= 5) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            softStop: true,
            message: "You've run several checks recently. Please wait a few minutes or contact us directly."
          })
        };
      }
    }

    // Input Parsing
    const { url, businessName } = parseInput(value);
    const findings = [];
    let mismatch = null;

    // Google PageSpeed Check
    if (url) {
      const pageSpeedResults = await runPageSpeedCheck(url, GOOGLE_API_KEY);
      findings.push(...pageSpeedResults.findings);
    }

    // Google Places Check
    if (businessName) {
      const placesResults = await runGooglePlacesCheck(businessName, GOOGLE_API_KEY);
      findings.push(...placesResults.findings);
      
      if (url && placesResults.website && !urlsMatch(url, placesResults.website)) {
        mismatch = `The website entered does not match the website linked to your Google Business Profile (${placesResults.website}).`;
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: 'Input',
        flag: 'warn',
        text: 'Enter both a website domain (e.g., clinic.com) and clinic name for full scoring.'
      });
    }

    // Score Calculation
    findings.sort((a, b) => (a.flag === 'warn' ? -1 : 1));
    const healthScore = calculateHealthScore(findings);
    const topFindings = findings.slice(0, 3);
    const additionalCount = Math.max(0, findings.length - 3);

    // Logging to Supabase
    if (supabase) {
      await supabase.from('audits').insert({
        ip_address: clientIp,
        search_query: value,
        health_score: healthScore,
        top_findings: topFindings,
        all_findings: findings,
        had_website: !!url,
        had_business_name: !!businessName
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        healthScore,
        topFindings,
        additionalCount,
        findings,
        hadWebsite: !!url,
        hadBusinessName: !!businessName,
        mismatch,
        alreadyChecked: false
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Diagnostic backend error. Unable to process request.' })
    };
  }
};

function parseInput(input) {
  const parts = input.split(',').map(s => s.trim());
  let url = null;
  let businessName = null;
  const urlPattern = /(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/[^\s]*)?/;

  parts.forEach(part => {
    if (urlPattern.test(part)) {
      url = part.startsWith('http') ? part : `https://${part}`;
    } else {
      businessName = part;
    }
  });

  return { url, businessName };
}

async function runPageSpeedCheck(targetUrl, apiKey) {
  const findings = [];
  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&strategy=mobile&category=PERFORMANCE&category=SEO${apiKey ? `&key=${apiKey}` : ''}`;
    const res = await fetch(endpoint);
    
    if (!res.ok) {
      return { findings: [{ category: 'Speed', flag: 'warn', text: 'Website responded too slowly or blocked automated speed checks.' }] };
    }

    const data = await res.json();
    const perfScore = Math.round((data.lighthouseResult?.categories?.performance?.score || 0) * 100);
    const lcp = data.lighthouseResult?.audits?.['largest-contentful-paint']?.numericValue || 0;
    const isHttps = targetUrl.startsWith('https://');

    if (perfScore < 60) {
      findings.push({ category: 'Speed', flag: 'warn', text: `Mobile speed score is low (${perfScore}/100). Patients drop off after 3 seconds.` });
    } else {
      findings.push({ category: 'Speed', flag: 'clear', text: `Mobile performance baseline is solid (${perfScore}/100).` });
    }

    if (lcp > 3500) {
      findings.push({ category: 'Performance', flag: 'warn', text: `Main page elements take ${(lcp / 1000).toFixed(1)}s to load on mobile.` });
    } else {
      findings.push({ category: 'Performance', flag: 'clear', text: `Mobile load time is optimal under 3.5 seconds.` });
    }

    if (!isHttps) {
      findings.push({ category: 'Security', flag: 'warn', text: 'Site lacks SSL (HTTPS). Browsers display a "Not Secure" warning to patients.' });
    } else {
      findings.push({ category: 'Security', flag: 'clear', text: 'SSL certificate active (HTTPS secure connection).' });
    }

  } catch (e) {
    findings.push({ category: 'Website', flag: 'warn', text: 'Could not complete automated website analysis.' });
  }

  return { findings };
}

async function runGooglePlacesCheck(name, apiKey) {
  const findings = [];
  let website = null;
  if (!apiKey) {
    return { findings: [{ category: 'Google Maps', flag: 'clear', text: 'Business profile detected.' }], website: null };
  }

  try {
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(name)}&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,website&key=${apiKey}`;
    const res = await fetch(searchUrl);
    const data = await res.json();

    const candidate = data.candidates?.[0];
    if (!candidate) {
      findings.push({ category: 'Google Maps', flag: 'warn', text: 'Practice not found on Google Maps top search results.' });
      return { findings, website };
    }

    website = candidate.website || null;
    const rating = candidate.rating || 0;
    const reviews = candidate.user_ratings_total || 0;

    if (rating < 4.2 || reviews < 15) {
      findings.push({ category: 'Reputation', flag: 'warn', text: `Google listing has ${reviews} reviews with a ${rating || 'N/A'} star rating.` });
    } else {
      findings.push({ category: 'Reputation', flag: 'clear', text: `Strong Google Maps profile (${rating} stars across ${reviews} reviews).` });
    }

    if (!website) {
      findings.push({ category: 'Google Maps', flag: 'warn', text: 'No website address linked on your Google Business Profile.' });
    }

  } catch (e) {
    findings.push({ category: 'Google Maps', flag: 'warn', text: 'Unable to verify Google Business Profile records.' });
  }

  return { findings, website };
}

function calculateHealthScore(findings) {
  let score = 100;
  findings.forEach(f => {
    if (f.flag === 'warn') score -= 18;
  });
  return Math.max(10, Math.min(100, score));
}

function urlsMatch(url1, url2) {
  const clean = u => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  return clean(url1) === clean(url2);
}
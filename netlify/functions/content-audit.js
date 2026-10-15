// Secure content-audit worker for the streaming Edge audit.
// Untrusted website/content fetching lives here instead of the Edge runtime so
// DNS validation and connection pinning can be enforced with Node's HTTP stack.

const { fetchPublicHttpUrl, validatePublicHttpUrl } = require('./ssrf-guard.cjs');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BOOKING_WIDGETS = /(calendly\.com|acuityscheduling|acuity\.com|nexhealth|zocdoc|squarespace-scheduling|setmore|simplybook|localmed|yapi|solutionreach|doctible|weave|dentrixascend|adit\.com)/i;
const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'threads.net'];
const SOCIAL_NON_PROFILE_PATH = /^\/(tr|sharer|share|intent|plugins|dialog|embed|watch|oauth)\b|\/embed\//i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request.' });
  }

  if (!payload.url || typeof payload.url !== 'string') {
    return json(400, { error: 'URL is required.' });
  }

  try {
    const result = await runWebsiteContentCheck(payload.url);
    return json(200, result);
  } catch (error) {
    console.error('content audit failed:', error.message);
    return json(200, { findings: [], html: '', finalUrl: payload.url, error: 'content_check_failed' });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function isPublicHttpUrl(url) {
  try {
    validatePublicHttpUrl(url);
    return true;
  } catch {
    return false;
  }
}

async function runWebsiteContentCheck(targetUrl) {
  const findings = [];
  let html = '';
  let finalUrl = targetUrl;
  if (!isPublicHttpUrl(targetUrl)) return { findings, html: '', finalUrl };

  try {
    const res = await fetchPublicHttpUrl(targetUrl, {
      timeout: 8000,
      maxBytes: 400_000,
      requireContentType: /\btext\/html\b|application\/xhtml\+xml/i,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
    });
    finalUrl = res.url || targetUrl;
    if (!res.ok) throw new Error(`homepage HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error('homepage fetch failed for', targetUrl, e.message);
    return { findings, html: '', finalUrl };
  }

  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  const looksLikeSpaShell = visibleText.length < 800 && (/\bid\s*=\s*["'](root|__next|app|__nuxt)["']/i.test(html) || scriptCount > 12);
  if (looksLikeSpaShell) {
    console.error('homepage looks like a client-rendered shell, skipping content checks:', targetUrl);
    return { findings, html, finalUrl, spa: true };
  }

  checkContactFriction(html, findings);
  checkImprovementLayer(html, findings);
  checkSocialMedia(html, findings);
  await Promise.all([
    checkBrokenLinks(html, finalUrl, findings),
    checkKeyPages(html, finalUrl, findings),
  ]);

  return { findings, html, finalUrl };
}

function checkSocialMedia(html, findings) {
  const hasSocial = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].some((m) => {
    let url;
    try { url = new URL(m[1].trim(), 'https://placeholder.invalid'); } catch { return false; }
    const host = url.hostname.toLowerCase();
    return SOCIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) && !SOCIAL_NON_PROFILE_PATH.test(url.pathname);
  });
  if (!hasSocial) {
    findings.push({ key: 'social-media', domain: 'website', severity: 'medium', title: 'Social media presence', value: 'none linked', consequence: 'No social media linked from your site. Many patients check it to see whether a practice is active before they book.', fix: 'Social media setup' });
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

function checkImprovementLayer(html, findings) {
  const metaTag = (html.match(/<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*>/i) || [])[0] || '';
  const metaDesc = (metaTag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1]
    || (metaTag.match(/\bcontent\s*=\s*([^\s">]+)/i) || [])[1] || '';
  if (metaDesc.trim().length < 50) {
    findings.push({ key: 'meta-description', domain: 'website', severity: 'low', title: 'Google search preview', value: metaDesc ? 'too short' : 'missing', consequence: "Google shows a summary of your page in results. Yours is missing or too thin to be useful.", fix: 'On-page SEO' });
  }

  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withAlt = imgs.filter((tag) => /\balt\s*=/i.test(tag)).length;
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
    findings.push({ key: 'faq-page', domain: 'website', severity: 'low', title: 'Questions & answers page', value: 'not found', consequence: 'Common questions answered on the page cut down phone back-and-forth.', fix: 'FAQ page' });
  }
  if (!hasPage(/insurance|\bfees\b|payment\s+options|financing|self[\s-]?pay/)) {
    findings.push({ key: 'fees-info', domain: 'website', severity: 'low', title: 'Fees & payment info', value: 'not found', consequence: "Patients want cost and insurance answered before they call. Without it, many go elsewhere.", fix: 'Fees / insurance page' });
  }

  const ldBlocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const ld = ldBlocks.join(' ');
  const hasLocalSchema = /"@type"\s*:\s*"(MedicalBusiness|MedicalClinic|MedicalOrganization|Dentist|Physician|Hospital|LocalBusiness|Pharmacy|Optometric|DiagnosticLab)"/i.test(ld);
  if (!ldBlocks.length) {
    findings.push({ key: 'schema', domain: 'website', severity: 'medium', title: 'Practice info for Google', value: 'none', consequence: "Nothing tells Google your name, address, hours and services in a form it can read reliably, so it has to guess from the page.", fix: 'On-page SEO', verdictPhrase: 'your structured data' });
  } else if (!hasLocalSchema) {
    findings.push({ key: 'schema', domain: 'website', severity: 'low', title: 'Practice info for Google', value: 'no practice type', consequence: "Your page has some structured data, but nothing marking it as a healthcare practice, which is a missed signal for local search.", fix: 'On-page SEO' });
  }
}

async function checkKeyPages(html, baseUrl, findings) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return; }
  const seen = new Set([baseUrl.replace(/#.*$/, '').replace(/\/$/, '')]);
  const urls = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) && urls.length < 4) {
    let abs;
    try { abs = new URL(match[1], baseUrl); } catch { continue; }
    if (abs.origin !== origin || !isPublicHttpUrl(abs.href)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx)$/i.test(abs.pathname)) continue;
    const norm = (abs.origin + abs.pathname).replace(/\/$/, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    urls.push(norm);
  }
  if (!urls.length) return;

  const pages = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetchPublicHttpUrl(url, {
        timeout: 5000,
        maxBytes: 120_000,
        requireContentType: /\btext\/html\b|application\/xhtml\+xml/i,
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
      });
      if (!response.ok) return null;
      const pageHtml = await response.text();
      const md = (pageHtml.match(/<meta[^>]+name\s*=\s*["']?description["']?[^>]*content\s*=\s*["']([^"']{20,})["']/i) || [])[1];
      const h1 = /<h1[\s>]/i.test(pageHtml);
      const title = (pageHtml.match(/<title[^>]*>([^<]{5,})<\/title>/i) || [])[1];
      return { md: !!md, h1, title: !!title };
    } catch {
      return null;
    }
  }));

  const ok = pages.filter(Boolean);
  const total = ok.length + 1;
  if (!ok.length) return;

  const noDesc = ok.filter((page) => !page.md).length;
  if (noDesc >= 1) {
    findings.push({ key: 'pages-meta', domain: 'website', severity: 'low', title: 'Search descriptions', value: `${noDesc} of ${total} pages missing`, consequence: 'Google shows a snippet under each page in results. Pages without one leave Google to pick the text itself.', fix: 'On-page SEO' });
  }

  const noH1 = ok.filter((page) => !page.h1).length;
  if (noH1 >= 1) {
    findings.push({ key: 'pages-h1', domain: 'website', severity: 'low', title: 'Page structure', value: `${noH1} of ${total} pages have no clear heading`, consequence: 'A page with no main heading is harder for Google and skim-readers to place.', fix: 'On-page SEO' });
  }
}

async function checkBrokenLinks(html, baseUrl, findings) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return; }

  const hrefs = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) && hrefs.size < 40) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    if (!isPublicHttpUrl(abs)) continue;
    hrefs.add(abs.split('#')[0]);
  }

  const links = [...hrefs]
    .sort((a, b) => (a.startsWith(origin) ? 0 : 1) - (b.startsWith(origin) ? 0 : 1))
    .slice(0, 20);
  if (!links.length) return;

  const results = await Promise.allSettled(links.map(async (link) => {
    try {
      const response = await fetchPublicHttpUrl(link, {
        method: 'HEAD',
        timeout: 4000,
        maxBytes: 0,
        headers: { 'User-Agent': BROWSER_UA },
      });
      return { link, status: response.status };
    } catch (error) {
      const dnsFailure = /dns|failed to lookup|name or service not known|no such host|enotfound/i.test(String(error && error.message));
      return { link, status: dnsFailure ? -1 : 0 };
    }
  }));

  const dead = results
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .filter((value) => value && (value.status === 404 || value.status === 410 || value.status === -1));

  if (dead.length) {
    findings.push({ key: 'broken-links', domain: 'website', severity: 'medium', title: 'Broken links', value: `${dead.length} dead`, consequence: 'Links on your homepage lead nowhere, so patients hit dead ends.', fix: 'Link cleanup', verdictPhrase: 'the broken links' });
  }
}

exports._test = { runWebsiteContentCheck };

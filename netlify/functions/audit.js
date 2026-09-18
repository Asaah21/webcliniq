// ============================================
// WebCliniQ: /.netlify/functions/audit
// ------------------------------------------
// Email capture only. The audit itself runs in the streaming edge function
// (netlify/edge-functions/audit.js at /api/audit-stream); this function
// emails those already-computed results via Resend and records the lead.
//
// Actions:
//   capture_email  email the results, insert into audit_leads, notify owner
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, FROM_EMAIL,
//      SITE_URL, NOTIFY_EMAIL
// ============================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'WebCliniQ <onboarding@resend.dev>';
const SITE_URL = (process.env.SITE_URL || 'https://webcliniq.com').replace(/\/$/, '');
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'support@webcliniq.com';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  if (payload.action === 'capture_email') {
    return await handleEmailCapture(payload);
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
};

/* ---------- Email capture ---------- */
async function handleEmailCapture(payload) {
  const { email, search_query, health_score, findings, ai_summary, audit_id, public_id } = payload;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: "That doesn't look like a valid email address." }) };
  }

  if (!RESEND_API_KEY) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'not_configured', message: "Email delivery isn't set up yet. Message me on WhatsApp and I'll send it directly." }) };
  }

  const reportUrl = public_id ? `${SITE_URL}/r/${encodeURIComponent(public_id)}` : null;
  const html = buildResultsEmailHtml({ search_query, health_score, findings: findings || [], ai_summary, reportUrl });

  const flaggedCount = (findings || []).filter((f) =>
    ['critical', 'high', 'medium'].includes(f.severity)
  ).length;
  const subject = flaggedCount === 1
    ? `${search_query || 'Your practice'}: the main thing affecting your patient bookings`
    : `${search_query || 'Your practice'}: ${flaggedCount} things affecting your patient bookings`;

  try {
    const res = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        reply_to: 'support@webcliniq.com',
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend send failed:', res.status, errText);
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'send_failed', message: "Couldn't send that right now. Try WhatsApp instead." }) };
    }
  } catch (err) {
    console.error('Resend send threw:', err.message);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'send_failed', message: "Couldn't send that right now. Try WhatsApp instead." }) };
  }

  if (supabase) {
    try {
      const { error } = await supabase.from('audit_leads').insert({
        email,
        search_query: search_query || null,
        health_score: health_score ?? null,
        findings: findings || [],
        audit_id: audit_id || null,
        consent_at: new Date().toISOString(),
        source: 'audit_email',
        status: 'new',
      });
      if (error) console.error('audit_leads insert failed:', error.message);
    } catch (insertErr) {
      console.error('audit_leads insert threw:', insertErr.message);
    }
  }

  // Ping the owner — best effort, never blocks the visitor's success.
  notifyNewLead({ email, search_query, health_score, reportUrl }).catch((e) => console.error('lead notify failed:', e.message));

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
}

async function notifyNewLead({ email, search_query, health_score, reportUrl }) {
  if (!RESEND_API_KEY) return;
  await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: NOTIFY_EMAIL,
      reply_to: email,
      subject: `New audit lead — ${search_query || email}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#12233D;">
               <p><strong>${esc(email)}</strong> asked for the full report.</p>
               <p>Searched: ${esc(search_query || '—')}<br>Score: ${health_score != null ? health_score + '/100' : '—'}</p>
               ${reportUrl ? `<p><a href="${esc(reportUrl)}">Open their report</a></p>` : ''}
               <p style="color:#6B7890;">Work it from the <code>audit_leads</code> table.</p>
             </div>`,
    }),
  });
}

function buildResultsEmailHtml({ search_query, health_score, findings, ai_summary, reportUrl }) {
  const practiceName = search_query || 'your practice';

  const critical = (findings || []).filter((f) => f.severity === 'critical');
  const high = (findings || []).filter((f) => f.severity === 'high');
  const medium = (findings || []).filter((f) => f.severity === 'medium').slice(0, 3);
  const urgent = [...critical, ...high].slice(0, 3);
  const topIssueCount = urgent.length + medium.length;

  const opening = health_score != null && health_score < 75
    ? `${esc(search_query || 'Your practice')} scored ${health_score}/100. ${topIssueCount === 1 ? 'The issue' : 'The issues'} below ${topIssueCount === 1 ? 'is' : 'are'} the kind that send patients to another practice instead.`
    : `I ran a check on ${esc(practiceName)}. A few things came up that are likely costing you patient bookings right now.`;

  const topFix = (findings || []).find((f) => ['critical', 'high'].includes(f.severity) && f.fix)
    || (findings || []).find((f) => f.severity === 'medium' && f.fix)
    || null;
  const topIssueTitle = topFix ? topFix.title.toLowerCase() : 'a few things';
  const waText = `Hi Emmanuel, I just got my audit results for ${search_query || 'my practice'}. Interested in sorting out ${topIssueTitle}. Can we talk?`;
  const waUrl = `https://wa.me/233538665715?text=${encodeURIComponent(waText)}`;

  const findingProse = (f) => `
    <p style="margin:0 0 16px;color:#1a1a1a;font-size:15px;line-height:1.6;">
      <strong>${esc(f.title)}${f.value && f.value !== 'flagged' ? `: ${esc(f.value)}` : ''}.</strong> ${esc(f.consequence || '')}
    </p>`;

  const urgentHtml = urgent.map(findingProse).join('');
  const mediumHtml = medium.map(findingProse).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#ffffff;padding:32px 16px;">
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">

    <p style="font-size:13px;color:#8595AD;margin:0 0 32px;">WebCliniQ</p>

    <p style="font-size:16px;color:#1a1a1a;line-height:1.6;margin:0 0 24px;">
      ${opening}
    </p>

    ${ai_summary ? `<p style="font-size:15px;color:#1a1a1a;line-height:1.6;margin:0 0 24px;">${esc(ai_summary)}</p>` : ''}

    ${urgentHtml ? `
    <p style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.08em;color:#6B7890;margin:0 0 12px;padding-top:20px;border-top:1px solid #ECEAE3;">
      What needs attention now
    </p>
    ${urgentHtml}` : ''}

    ${mediumHtml ? `
    <p style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.08em;color:#6B7890;margin:0 0 12px;padding-top:20px;border-top:1px solid #ECEAE3;">
      Worth fixing soon
    </p>
    ${mediumHtml}` : ''}

    <div style="padding-top:24px;border-top:1px solid #ECEAE3;">
      <a href="${esc(waUrl)}"
         style="display:block;background:#D65B34;color:#fff;padding:14px 24px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold;text-align:center;">
        Message Emmanuel on WhatsApp
      </a>
      ${reportUrl ? `<p style="text-align:center;margin:12px 0 0;">
        <a href="${esc(reportUrl)}" style="color:#6B7890;font-size:13px;">
          Or view your full results online →
        </a></p>` : ''}
    </div>

    <p style="margin:32px 0 0;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Emmanuel<br>
      <span style="color:#6B7890;font-size:13px;">I'm a nurse who got tired of seeing good practices lose patients
      to worse ones just because of how they show up online.</span>
    </p>

    <p style="font-size:12px;color:#8595AD;margin-top:32px;padding-top:16px;border-top:1px solid #ECEAE3;">
      You asked WebCliniQ to email your audit results.
      <a href="mailto:support@webcliniq.com" style="color:#8595AD;">Reply to unsubscribe.</a><br>
      support@webcliniq.com · WebCliniQ
    </p>

  </div>
  </body></html>`;
}

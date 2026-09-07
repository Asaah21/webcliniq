// ============================================
// WebCliniQ — /.netlify/functions/report
// Serves the read-only hosted audit report at /r/<public_id>
// (_redirects rewrites /r/* -> this function, 200).
// ============================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WHATSAPP_NUMBER = '233538665715';

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (statusCode, title, bodyHtml) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  body: shell(title, bodyHtml),
});

exports.handler = async (event) => {
  const id = (event.queryStringParameters && event.queryStringParameters.id)
    || (event.path || '').replace(/\/+$/, '').split('/').pop();

  if (!id || id === 'report') {
    return page(404, 'Report not found', `<h1>Report not found</h1><p>That link doesn't point to a report. <a href="/">Run a new check</a>.</p>`);
  }
  if (!supabase) {
    return page(500, 'Report unavailable', `<h1>Report unavailable</h1><p>The report service isn't configured right now.</p>`);
  }

  let row;
  try {
    const { data, error } = await supabase
      .from('audits')
      .select('search_query, health_score, all_findings, screenshot, created_at')
      .eq('public_id', id)
      .single();
    if (error || !data) {
      return page(404, 'Report not found', `<h1>Report not found</h1><p>This report link has expired or never existed. <a href="/">Run a new check</a>.</p>`);
    }
    row = data;
  } catch (e) {
    console.error('report lookup failed:', e.message);
    return page(500, 'Report unavailable', `<h1>Report unavailable</h1><p>Something went wrong loading this report. Try again shortly.</p>`);
  }

  return page(200, `Report for ${row.search_query || 'your practice'}`, reportBody(row));
};

function reportBody(row) {
  const findings = Array.isArray(row.all_findings) ? row.all_findings : [];
  const attention = findings.filter((f) => f.severity && f.severity !== 'clear');
  const clear = findings.filter((f) => f.severity === 'clear');
  const name = row.search_query || 'your practice';
  const score = row.health_score;
  const dateStr = row.created_at ? new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  const attentionRows = attention.map((f) => `
    <div class="row">
      <div class="row-head">
        <span class="dot ${f.severity === 'critical' || f.severity === 'high' ? 'urgent' : ''}"></span>
        <h3>${esc(f.title)}</h3>
        ${f.value ? `<span class="fig">${esc(f.value)}${f.benchmark ? ` <span class="bench">vs ${esc(f.benchmark)}</span>` : ''}</span>` : ''}
      </div>
      ${f.consequence ? `<p class="conseq">${esc(f.consequence)}</p>` : ''}
      ${f.fix ? `<p class="fix"><span>The fix</span> ${esc(f.fix)}</p>` : ''}
    </div>`).join('');

  const clearRows = clear.map((f) => `<li>${esc(f.title)}${f.value ? ` &mdash; ${esc(f.value)}` : ''}</li>`).join('');

  const waText = attention.length
    ? `Hi WebCliniQ. I've read my full report for "${name}". I'd like to sort out ${attention[0].title.toLowerCase()}.`
    : `Hi WebCliniQ. I've read my full report for "${name}" and wanted to follow up.`;
  const wa = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;

  return `
  <header class="rpt-head">
    <span class="logo">WebClini<b>Q</b></span>
    <span class="date">${esc(dateStr)}</span>
  </header>

  <h1>Full report for ${esc(name)}</h1>

  <div class="summary">
    ${score != null ? `<div class="score"><b>${esc(String(score))}</b><span>/ 100</span></div>` : ''}
    <p>${attention.length
      ? `${attention.length} ${attention.length === 1 ? 'thing needs' : 'things need'} attention, ${clear.length} looking good. They're listed worst-first below, each with what fixes it.`
      : `Nothing urgent — a few smaller things to tighten, listed below.`}</p>
  </div>

  ${row.screenshot ? `<figure class="shot"><img src="${esc(row.screenshot)}" alt="Your site on a phone"><figcaption>Your site on a phone</figcaption></figure>` : ''}

  <section>
    <h2>Needs attention</h2>
    ${attentionRows || '<p class="none">Nothing flagged.</p>'}
  </section>

  ${clearRows ? `<section><h2>Looking good</h2><ul class="clear-list">${clearRows}</ul></section>` : ''}

  <div class="cta">
    <a class="btn" href="${wa}">Message us about the top fix</a>
    <p>One person, and it's the person doing the work. Most fixes are small and fixed-scope — you see the number before anything starts.</p>
  </div>

  <footer class="rpt-foot">
    WebCliniQ &middot; web care for healthcare practices &middot; support@webcliniq.com
  </footer>`;
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — WebCliniQ</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap">
<style>
  :root{ --ink:#12233D; --soft:#45566E; --muted:#6B7890; --line:#DCE2EA; --paper:#FFFFFF; --alt:#F5F7FA; --warm:#D65B34; --green:#1C8E77; }
  *{box-sizing:border-box}
  body{ margin:0; background:var(--alt); color:var(--ink); font:16px/1.6 'Inter',system-ui,sans-serif; }
  .wrap{ max-width:680px; margin:0 auto; padding:32px 22px 64px; }
  .rpt-head{ display:flex; justify-content:space-between; align-items:baseline; padding-bottom:14px; border-bottom:2px solid var(--ink); }
  .logo{ font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.25rem; }
  .logo b{ color:var(--warm); font-weight:700; }
  .date{ font-family:'JetBrains Mono',monospace; font-size:.75rem; color:var(--muted); }
  h1{ font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.7rem; letter-spacing:-.02em; margin:24px 0 16px; text-wrap:balance; }
  h2{ font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:1.15rem; margin:32px 0 12px; }
  h3{ font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:1rem; margin:0; }
  .summary{ display:flex; gap:18px; align-items:center; background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:18px; }
  .summary p{ margin:0; font-size:.95rem; color:var(--soft); }
  .score{ flex-shrink:0; text-align:center; line-height:1; }
  .score b{ font-family:'Space Grotesk',sans-serif; font-size:2rem; }
  .score span{ display:block; font-family:'JetBrains Mono',monospace; font-size:.7rem; color:var(--muted); margin-top:3px; }
  .shot{ margin:22px 0 0; }
  .shot img{ max-width:220px; width:100%; border:1px solid var(--line); border-radius:8px; display:block; }
  .shot figcaption{ font-family:'JetBrains Mono',monospace; font-size:.72rem; color:var(--muted); margin-top:6px; }
  .row{ background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:10px 0; }
  .row-head{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .dot{ width:8px; height:8px; border-radius:50%; background:var(--line); flex-shrink:0; }
  .dot.urgent{ background:var(--warm); }
  .fig{ margin-left:auto; font-family:'JetBrains Mono',monospace; font-size:.8rem; color:var(--soft); }
  .bench{ color:var(--muted); }
  .conseq{ margin:8px 0 0; font-size:.9rem; color:var(--soft); }
  .fix{ margin:10px 0 0; font-size:.9rem; color:var(--ink); }
  .fix span{ font-family:'JetBrains Mono',monospace; font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:var(--green); margin-right:6px; }
  .clear-list{ margin:0; padding-left:20px; color:var(--soft); font-size:.92rem; }
  .clear-list li{ margin:4px 0; }
  .none{ color:var(--muted); font-size:.92rem; }
  .cta{ margin:36px 0 0; background:var(--ink); color:#fff; border-radius:12px; padding:24px; text-align:center; }
  .cta .btn{ display:inline-block; background:var(--warm); color:#fff; font-weight:600; text-decoration:none; padding:12px 24px; border-radius:6px; }
  .cta p{ margin:14px 0 0; font-size:.85rem; color:#B7C4D6; }
  .rpt-foot{ margin-top:28px; padding-top:16px; border-top:1px solid var(--line); font-family:'JetBrains Mono',monospace; font-size:.72rem; color:var(--muted); text-align:center; }
  a{ color:var(--warm); }
  @media print{
    body{ background:#fff; } .wrap{ padding:0; }
    .cta{ background:#fff; color:var(--ink); border:1px solid var(--line); } .cta .btn{ display:none; } .cta p{ color:var(--soft); }
    .row, .summary{ break-inside:avoid; }
  }
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initReveal();
  initFAQ();
  initAuditBar();
});

/* ---------- Mobile nav ---------- */
function initNav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => links.classList.toggle('open'));
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
}

/* ---------- Scroll reveal ---------- */
function initReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach(el => el.classList.add('in'));
    return;
  }
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        obs.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  items.forEach(el => obs.observe(el));
}

/* ---------- FAQ accordion ---------- */
function initFAQ() {
  const items = document.querySelectorAll('.faq-item');
  items.forEach(item => {
    const q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      items.forEach(i => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });
}

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function stripProto(u) {
  return String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ============================================
   Audit bar + results panel
   ============================================ */
function initAuditBar() {
  const form = document.getElementById('audit-form');
  const hint = document.getElementById('audit-hint');
  const loading = document.getElementById('audit-loading');
  const errorBox = document.getElementById('audit-error');
  const results = document.getElementById('audit-results');
  const matchEl = document.getElementById('audit-match');
  const dialEl = document.getElementById('audit-dial');
  const scoreEl = document.getElementById('audit-score');
  const verdictEl = document.getElementById('audit-verdict');
  const noticeEl = document.getElementById('audit-notice');
  const findingsList = document.getElementById('audit-findings');
  const moreEl = document.getElementById('audit-more');
  const ctaEl = document.getElementById('audit-cta');
  const againEl = document.getElementById('audit-again');
  if (!form) return;

  const WHATSAPP_NUMBER = '233538665715';
  const MAX_RUNS_PER_VISIT = 3;
  let auditRunCount = 0;
  let loadingInterval;

  const loadingMessages = [
    "Checking what's public about your practice…",
    'Looking up your Google listing…',
    'Checking your site on a phone…',
    'Sorting what matters most…',
  ];

  function startLoadingTicker() {
    loading.classList.add('active');
    const textEl = loading.querySelector('.audit-loading-text') || loading;
    let step = 0;
    textEl.textContent = loadingMessages[0];
    loadingInterval = setInterval(() => {
      step++;
      if (step < loadingMessages.length) textEl.textContent = loadingMessages[step];
    }, 2200);
  }
  function stopLoadingTicker() {
    clearInterval(loadingInterval);
    loading.classList.remove('active');
  }

  function resetPanels() {
    errorBox.classList.remove('active');
    results.classList.remove('active');
    [matchEl, noticeEl, moreEl, againEl].forEach(el => { if (el) { el.hidden = true; el.innerHTML = ''; } });
    if (findingsList) findingsList.innerHTML = '';
    if (dialEl) dialEl.innerHTML = '';
    if (scoreEl) scoreEl.innerHTML = '';
    if (verdictEl) verdictEl.textContent = '';
    if (ctaEl) ctaEl.innerHTML = '';
  }

  function showError(message) {
    errorBox.querySelector('p').textContent = message;
    errorBox.classList.add('active');
    form.classList.remove('hidden');
    if (hint) hint.style.display = '';
  }

  function resetToForm() {
    results.classList.remove('active');
    form.classList.remove('hidden');
    if (hint) hint.style.display = '';
    const input = document.getElementById('audit-input');
    if (input) { input.value = ''; input.focus(); }
  }

  /* ---- score dial ---- */
  function renderDial(score) {
    const r = 42;
    const circ = 2 * Math.PI * r;
    const target = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
    // Number is final immediately; the arc sweeps in via its CSS transition.
    dialEl.innerHTML =
      `<svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">
         <circle class="audit-dial-track" cx="48" cy="48" r="${r}"></circle>
         <circle class="audit-dial-arc" cx="48" cy="48" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"></circle>
       </svg>
       <span class="audit-dial-num">${score}</span>`;
    const arc = dialEl.querySelector('.audit-dial-arc');
    if (prefersReducedMotion()) arc.style.strokeDashoffset = target;
    else setTimeout(() => { arc.style.strokeDashoffset = target; }, 40);
  }

  /* ---- one finding row ---- */
  function findingRow(f, i) {
    const urgent = f.severity === 'critical' || f.severity === 'high';
    const li = document.createElement('li');
    li.className = 'af-row';
    const fig = f.value
      ? `<span class="af-fig">${escapeHtml(f.value)}${f.benchmark ? `<br><span class="af-bench">vs ${escapeHtml(f.benchmark)}</span>` : ''}</span>`
      : '';
    li.innerHTML =
      `<span class="af-dot${urgent ? ' urgent' : ''}"></span>
       <span class="af-body">
         <span class="af-title">${escapeHtml(f.title)}</span>
         ${f.consequence ? `<span class="af-desc">${escapeHtml(f.consequence)}</span>` : ''}
       </span>
       ${fig}`;
    findingsList.appendChild(li);
    if (prefersReducedMotion()) li.classList.add('in');
    else setTimeout(() => li.classList.add('in'), 80 + i * 90);
  }

  /* ---- CTA ladder: email report -> WhatsApp ---- */
  function renderCta(value, topFix, data) {
    const waText = topFix
      ? `Hi WebCliniQ. I ran a check for "${value}". The main thing flagged: ${topFix.title}${topFix.value ? ` (${topFix.value})` : ''}. I'd like to get this sorted.`
      : `Hi WebCliniQ. I ran a check for "${value}" and wanted to follow up.`;
    const wa = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;

    ctaEl.innerHTML =
      `<form class="audit-email-form" id="audit-email-form">
         <input type="email" id="audit-email-input" placeholder="you@yourpractice.com" required aria-label="Your email">
         <button type="submit" class="btn btn-primary">Email me the full report</button>
       </form>
       <span class="audit-email-msg" id="audit-email-msg" hidden></span>
       <a class="audit-cta-wa" href="${wa}" target="_blank" rel="noopener">Message on WhatsApp about the top fix</a>`;

    document.getElementById('audit-email-form').addEventListener('submit', (e) => onEmailSubmit(e, value, data));
  }

  async function onEmailSubmit(e, value, data) {
    e.preventDefault();
    const email = document.getElementById('audit-email-input').value.trim();
    const formEl = e.currentTarget;
    const btn = formEl.querySelector('button');
    const msg = document.getElementById('audit-email-msg');
    btn.textContent = 'Sending…';
    btn.disabled = true;
    try {
      const res = await fetch('/.netlify/functions/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'capture_email',
          email,
          search_query: value,
          health_score: data.score,
          letter_grade: null,
          findings: data.findings,
        }),
      });
      const result = await res.json();
      if (result.success) {
        formEl.hidden = true;
        msg.textContent = 'Sent. Check your inbox.';
        msg.className = 'audit-email-msg ok';
        msg.hidden = false;
      } else {
        msg.textContent = result.message || "Couldn't send that right now — message on WhatsApp instead.";
        msg.className = 'audit-email-msg warn';
        msg.hidden = false;
        btn.textContent = 'Email me the full report';
        btn.disabled = false;
      }
    } catch (err) {
      msg.textContent = "Couldn't send that right now — message on WhatsApp instead.";
      msg.className = 'audit-email-msg warn';
      msg.hidden = false;
      btn.textContent = 'Email me the full report';
      btn.disabled = false;
    }
  }

  function buildAgainLink() {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      againEl.innerHTML = '<span>Checked a few already? Message us for more.</span>';
    } else {
      againEl.innerHTML = '<a id="audit-again-link">Check another practice</a>';
      const link = document.getElementById('audit-again-link');
      if (link) link.addEventListener('click', resetToForm);
    }
    againEl.hidden = false;
  }

  /* ---- render a full result ---- */
  function renderResults(data, value) {
    // match line
    if (data.matched && data.matched.name) {
      const site = data.matched.website ? ` &rarr; <b>${escapeHtml(stripProto(data.matched.website))}</b>` : '';
      matchEl.innerHTML = `We matched <b>${escapeHtml(data.matched.name)}</b>${site}. <a id="audit-notyou">Not you?</a>`;
      matchEl.hidden = false;
    }

    // score + verdict + dial
    const name = (data.matched && data.matched.name) || value || '';
    scoreEl.innerHTML = `<b>${data.score != null ? data.score : '&mdash;'}</b> / 100${name ? ` &middot; ${escapeHtml(name)}` : ''}`;
    verdictEl.textContent = data.verdict || '';
    if (data.score != null) renderDial(data.score);

    // notice (non-healthcare / website mismatch)
    let notice = '';
    if (data.isHealthcare === false) notice = "WebCliniQ is built for healthcare practices — here's what we found anyway.";
    if (data.mismatch) notice = data.mismatch;
    if (notice) { noticeEl.textContent = notice; noticeEl.hidden = false; }

    // findings: the priority ones, then up to 2 "clear" reassurances
    const shown = (data.topFindings || []).slice(0, 5);
    const clears = (data.findings || []).filter(f => f.severity === 'clear').slice(0, 2);
    [...shown, ...clears].forEach((f, i) => findingRow(f, i));

    // "+N more" — a contact hook, not an expander
    const more = data.moreCount || 0;
    if (more > 0) {
      moreEl.innerHTML = `<b>${more} more ${more === 1 ? 'issue' : 'issues'} found</b> — smaller things like copy and missing pages. Email yourself the full report below to see them all, each with the fix.`;
      moreEl.hidden = false;
    }

    // CTA
    const topFix = shown.find(f => f.severity === 'critical' || f.severity === 'high') || shown[0] || null;
    renderCta(value, topFix, data);

    buildAgainLink();
    results.classList.add('active');

    const notYou = document.getElementById('audit-notyou');
    if (notYou) notYou.addEventListener('click', resetToForm);
  }

  async function runAudit(value) {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      resetPanels();
      verdictEl.textContent = "You've checked a few things already. Give it a bit, then try again, or message us directly.";
      results.classList.add('active');
      return;
    }
    auditRunCount++;

    form.classList.add('hidden');
    if (hint) hint.style.display = 'none';
    resetPanels();
    startLoadingTicker();

    try {
      const res = await fetch('/.netlify/functions/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      stopLoadingTicker();

      if (!res.ok || data.error) {
        showError(data.error || 'Something went wrong running that check.');
        return;
      }
      if (data.softStop) {
        verdictEl.textContent = data.message || "You've run a few checks already. Give it a few minutes, then try again.";
        results.classList.add('active');
        return;
      }
      renderResults(data, value);
    } catch (err) {
      stopLoadingTicker();
      showError('Something went wrong reaching the audit service.');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('audit-input').value.trim();
    if (val) runAudit(val);
  });
}

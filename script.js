// ============================================
// WebCliniQ — shared behavior
// ============================================

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

/* ============================================
   Audit bar — real audit via serverless function
   ------------------------------------------
   Calls /.netlify/functions/audit, which runs a
   real Google PageSpeed check (if the input looks
   like a URL) or a real Google Places lookup (if it
   looks like a business name). No simulated results —
   the backend never fakes data, and always translates
   technical errors into plain language before they
   reach this file.

   Capped at two checks per page load — enough to check
   one thing and then add the other, not enough to spam
   the backend. The Netlify function enforces the same
   cap per IP as a backstop.

   The secondary "email this report" field is a real
   Netlify Form, only functional once deployed on Netlify.
   ============================================ */
function initAuditBar() {
  const form = document.getElementById('audit-form');
  const hint = document.getElementById('audit-hint');
  const loading = document.getElementById('audit-loading');
  const errorBox = document.getElementById('audit-error');
  const results = document.getElementById('audit-results');
  const findingsList = document.getElementById('audit-findings');
  const urgentBox = document.getElementById('audit-urgent');
  const mismatchBox = document.getElementById('audit-mismatch');
  const summary = document.getElementById('audit-results-summary');
  const ctaGroup = document.getElementById('audit-cta-group');
  const ctaLink = document.getElementById('audit-cta-link');
  const nudgeBox = document.getElementById('audit-nudge');
  const againBox = document.getElementById('audit-again');
  if (!form) return;

  const WHATSAPP_NUMBER = '233538665715';
  const MAX_RUNS_PER_VISIT = 2;
  let auditRunCount = 0;

  function resetPanels() {
    errorBox.classList.remove('active');
    results.classList.remove('active');
    nudgeBox.innerHTML = '';
    againBox.innerHTML = '';
    urgentBox.classList.remove('active'); urgentBox.innerHTML = '';
    mismatchBox.classList.remove('active'); mismatchBox.innerHTML = '';
    ctaGroup.classList.remove('hidden', 'soft');
  }

  function showError(message) {
    errorBox.querySelector('p').textContent = message;
    errorBox.classList.add('active');
    form.classList.remove('hidden');
    if (hint) hint.style.display = '';
  }

  function showSoftStop(message) {
    results.classList.add('active');
    if (summary) summary.textContent = message;
    ctaGroup.classList.add('hidden');
  }

  function setCtaLinks(value, topFinding) {
    const waText = topFinding
      ? `Hi WebCliniQ. I ran an audit for "${value}". Top issue: ${topFinding.text} I'd like to get this fixed.`
      : `Hi WebCliniQ. I ran an audit for "${value}" and wanted to follow up.`;
    if (ctaLink) ctaLink.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;

    const emailLink = document.getElementById('audit-cta-email-link');
    if (emailLink) {
      const emailSubject = `Audit follow-up: ${value}`;
      const emailBody = topFinding
        ? `Hi WebCliniQ,\n\nI ran the audit for "${value}". Top issue: ${topFinding.text}\n\nI'd like to talk about getting this fixed.`
        : `Hi WebCliniQ,\n\nI ran the audit for "${value}" and wanted to follow up.`;
      emailLink.href = `mailto:support@webcliniq.com?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;
    }
  }

  function applyCtaMode(mode, label) {
    ctaGroup.classList.remove('hidden', 'soft');
    if (mode === 'hidden') ctaGroup.classList.add('hidden');
    if (mode === 'soft') ctaGroup.classList.add('soft');
    if (ctaLink && label) ctaLink.textContent = label;
  }

  function buildNudge(data, value) {
    const isMissingWebsite = data.hadWebsite === false;
    const label = isMissingWebsite ? "Add your website for a fuller picture" : "Add your business name for a Google check";
    const placeholder = isMissingWebsite ? 'yourclinic.com' : 'Your Business Name';

    nudgeBox.innerHTML =
      `<p class="audit-nudge-label">${label}</p>
       <form class="audit-nudge-form" id="audit-nudge-form">
         <input type="text" id="audit-nudge-input" placeholder="${placeholder}">
         <button type="submit" class="btn btn-outline">Add</button>
       </form>
       <span class="audit-nudge-skip" id="audit-nudge-skip">Skip. I'll just get in touch.</span>`;

    const nudgeForm = document.getElementById('audit-nudge-form');
    if (nudgeForm) {
      nudgeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const extra = document.getElementById('audit-nudge-input').value.trim();
        if (extra) runAudit(`${value}, ${extra}`);
      });
    }
    const skipLink = document.getElementById('audit-nudge-skip');
    if (skipLink) {
      skipLink.addEventListener('click', () => {
        nudgeBox.innerHTML = '';
        applyCtaMode('soft', 'Message Us on WhatsApp');
      });
    }
  }

  function buildAgainLink() {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      againBox.innerHTML = `<span>Checked a couple already? Message us for more.</span>`;
      return;
    }
    againBox.innerHTML = `<a id="audit-again-link">Check another business</a>`;
    const link = document.getElementById('audit-again-link');
    if (link) {
      link.addEventListener('click', () => {
        results.classList.remove('active');
        form.classList.remove('hidden');
        if (hint) hint.style.display = '';
        const input = document.getElementById('audit-input');
        if (input) { input.value = ''; input.focus(); }
      });
    }
  }

  function renderResults(data, value) {
    const list = data.findings || [];
    const incomplete = data.hadWebsite === false || data.hadBusinessName === false;

    if (data.mismatch) {
      mismatchBox.innerHTML = `<span class="audit-mismatch-label">Double-check</span><span>${data.mismatch}</span>`;
      mismatchBox.classList.add('active');
    }

    let topFinding = null;
    let listToShow = list;
    if (!data.alreadyChecked && list.length && list[0].flag === 'warn') {
      topFinding = list[0];
      listToShow = list.slice(1);
      urgentBox.innerHTML = `<span class="audit-urgent-label">Most Urgent</span><span>${topFinding.text}</span>`;
      urgentBox.classList.add('active');
    }

    findingsList.innerHTML = '';
    listToShow.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="vitals-flag ${f.flag}">${f.flag === 'warn' ? 'Flag' : 'Clear'}</span><span>${f.text}</span>`;
      findingsList.appendChild(li);
      setTimeout(() => li.classList.add('in'), i * 140);
    });

    const remaining = listToShow.filter(f => f.flag === 'warn').length;
    const hasAnyWarn = list.some(f => f.flag === 'warn');
    if (summary) {
      summary.textContent = data.alreadyChecked ? '' :
        remaining > 0 ? `${remaining} more issue${remaining === 1 ? '' : 's'} below.` :
        'Nothing else urgent. Solid baseline.';
    }

    setCtaLinks(value, topFinding);

    if (data.alreadyChecked) {
      applyCtaMode('soft', 'Message Us on WhatsApp');
    } else if (incomplete) {
      applyCtaMode('hidden');
    } else if (data.mismatch) {
      applyCtaMode('soft', 'Message Us on WhatsApp');
    } else if (!hasAnyWarn) {
      applyCtaMode('soft', 'Questions? Message Us');
    } else {
      applyCtaMode('primary', 'Message Us on WhatsApp');
    }

    if (!data.alreadyChecked) {
      if (incomplete) {
        buildNudge(data, value);
      } else {
        buildAgainLink();
      }
    }

    results.classList.add('active');
  }

  async function runAudit(value) {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      resetPanels();
      showSoftStop("You've checked a couple of things already. Give it a bit, then try again, or message us directly.");
      return;
    }
    auditRunCount++;

    form.classList.add('hidden');
    if (hint) hint.style.display = 'none';
    resetPanels();
    loading.classList.add('active');

    try {
      const res = await fetch('/.netlify/functions/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      loading.classList.remove('active');

      if (!res.ok || data.error) {
        showError(data.error || 'Something went wrong running that check.');
        return;
      }

      if (data.softStop) {
        showSoftStop(data.message || "You've run a couple of checks already. Give it a few minutes, then try again.");
        return;
      }

      renderResults(data, value);
    } catch (err) {
      loading.classList.remove('active');
      showError('Something went wrong reaching the audit service.');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('audit-input');
    const value = input.value.trim();
    if (value) runAudit(value);
  });
}

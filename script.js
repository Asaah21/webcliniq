// ============================================
// WebCliniK — shared behavior
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
   real Google PageSpeed Insights check (if the
   input looks like a URL) or a real Google Places
   lookup (if it looks like a business name). No
   simulated results — if the backend isn't
   configured (missing GOOGLE_API_KEY) or the
   check fails, this shows a plain error instead
   of making anything up.

   The secondary "email this report" field is a
   real Netlify Form, only functional once deployed
   on Netlify.
   ============================================ */
function initAuditBar() {
  const form = document.getElementById('audit-form');
  const hint = document.getElementById('audit-hint');
  const loading = document.getElementById('audit-loading');
  const errorBox = document.getElementById('audit-error');
  const results = document.getElementById('audit-results');
  const findingsList = document.getElementById('audit-findings');
  const urgentBox = document.getElementById('audit-urgent');
  const summary = document.getElementById('audit-results-summary');
  const ctaLink = document.getElementById('audit-cta-link');
  const nudgeBox = document.getElementById('audit-nudge');
  if (!form) return;

  const WHATSAPP_NUMBER = '233538665715';

  async function runAudit(value) {
    form.classList.add('hidden');
    if (hint) hint.style.display = 'none';
    errorBox.classList.remove('active');
    results.classList.remove('active');
    nudgeBox.innerHTML = '';
    urgentBox.classList.remove('active');
    urgentBox.innerHTML = '';
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
        errorBox.querySelector('p').textContent = data.error || 'Something went wrong running that check.';
        errorBox.classList.add('active');
        form.classList.remove('hidden');
        if (hint) hint.style.display = '';
        return;
      }

      const list = data.findings || [];
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
      if (summary) {
        summary.textContent = data.alreadyChecked
          ? ''
          : remaining > 0
            ? `${remaining} more issue${remaining === 1 ? '' : 's'} below.`
            : 'Nothing else urgent — solid baseline.';
      }

      const waText = topFinding
        ? `Hi WebCliniQ! I ran an audit for "${value}". Top issue: ${topFinding.text} I'd like to get this fixed.`
        : `Hi WebCliniQ! I ran an audit for "${value}" and wanted to follow up.`;
      if (ctaLink) ctaLink.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;

      if (!data.alreadyChecked) {
        if (data.hadWebsite === false) {
          nudgeBox.innerHTML =
            `<p class="audit-nudge-label">Add your website for a fuller read →</p>
             <form class="audit-nudge-form" id="audit-nudge-form">
               <input type="text" id="audit-nudge-input" placeholder="yourclinic.com">
               <button type="submit" class="btn btn-outline">Add</button>
             </form>`;
        } else if (data.hadBusinessName === false) {
          nudgeBox.innerHTML =
            `<p class="audit-nudge-label">Add your business name for a Google visibility check →</p>
             <form class="audit-nudge-form" id="audit-nudge-form">
               <input type="text" id="audit-nudge-input" placeholder="Your Clinic Name">
               <button type="submit" class="btn btn-outline">Add</button>
             </form>`;
        }
        const nudgeForm = document.getElementById('audit-nudge-form');
        if (nudgeForm) {
          nudgeForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const extra = document.getElementById('audit-nudge-input').value.trim();
            if (extra) runAudit(`${value}, ${extra}`);
          });
        }
      }

      results.classList.add('active');
    } catch (err) {
      loading.classList.remove('active');
      errorBox.querySelector('p').textContent = 'Something went wrong reaching the audit service.';
      errorBox.classList.add('active');
      form.classList.remove('hidden');
      if (hint) hint.style.display = '';
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('audit-input');
    const value = input.value.trim();
    if (value) runAudit(value);
  });
}

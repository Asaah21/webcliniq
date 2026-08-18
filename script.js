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
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('audit-input');
    const value = input.value.trim();
    if (!value) return;

    form.classList.add('hidden');
    if (hint) hint.style.display = 'none';
    errorBox.classList.remove('active');
    results.classList.remove('active');
    loading.classList.add('active');

    const emailContext = document.getElementById('audit-email-context');
    if (emailContext) emailContext.value = value;

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

      findingsList.innerHTML = '';
      (data.findings || []).forEach(f => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="vitals-flag ${f.flag}">${f.flag === 'warn' ? 'Flag' : 'Clear'}</span><span>${f.text}</span>`;
        findingsList.appendChild(li);
      });
      results.classList.add('active');
    } catch (err) {
      loading.classList.remove('active');
      errorBox.querySelector('p').textContent = 'Something went wrong reaching the audit service.';
      errorBox.classList.add('active');
      form.classList.remove('hidden');
      if (hint) hint.style.display = '';
    }
  });

  const emailForm = document.getElementById('audit-email-form');
  const emailConfirm = document.getElementById('audit-email-confirm');
  if (emailForm) {
    emailForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = new FormData(emailForm);
      fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData).toString(),
      })
        .catch(() => { /* expected off-Netlify */ })
        .finally(() => {
          emailForm.classList.add('hidden');
          emailConfirm.classList.add('active');
        });
    });
  }
}

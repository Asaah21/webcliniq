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
   Audit bar
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
  const MAX_RUNS_PER_VISIT = 3;
  let auditRunCount = 0;
  let loadingInterval;

  // Plain language only — no service/API names, matches the rest of the site.
  const loadingMessages = [
    'Running your audit…',
    'Checking your site speed…',
    'Looking up your Google listing…',
    'Almost done…',
  ];

  function startLoadingTicker() {
    loading.classList.add('active');
    const textEl = loading.querySelector('.audit-loading-text') || loading;
    let step = 0;
    textEl.textContent = loadingMessages[0];
    loadingInterval = setInterval(() => {
      step++;
      if (step < loadingMessages.length) textEl.textContent = loadingMessages[step];
    }, 1800);
  }

  function stopLoadingTicker() {
    clearInterval(loadingInterval);
    loading.classList.remove('active');
  }

  function resetPanels() {
    errorBox.classList.remove('active');
    results.classList.remove('active');
    nudgeBox.innerHTML = '';
    againBox.innerHTML = '';
    urgentBox.classList.remove('active'); urgentBox.innerHTML = '';
    mismatchBox.classList.remove('active'); mismatchBox.innerHTML = '';
    ctaGroup.classList.remove('hidden', 'soft');
    const existingEmailCta = document.getElementById('audit-email-capture');
    if (existingEmailCta) existingEmailCta.remove();
  }

  function showError(message) {
    errorBox.querySelector('p').textContent = message;
    errorBox.classList.add('active');
    form.classList.remove('hidden');
    if (hint) hint.style.display = '';
  }

  function gradeClass(grade) {
    if (grade === 'A' || grade === 'B') return 'grade-good';
    if (grade === 'C') return 'grade-mid';
    return 'grade-warn';
  }

  function renderEmailCapture(value, data) {
    const wrap = document.createElement('div');
    wrap.id = 'audit-email-capture';
    wrap.className = 'audit-email-capture';
    wrap.innerHTML = `
      <p class="audit-email-label">Want these results in your inbox?</p>
      <form class="audit-email-form" id="audit-email-form">
        <input type="email" id="audit-email-input" placeholder="you@yourpractice.com" required>
        <button type="submit" class="btn btn-outline">Email Me This</button>
      </form>
      <span class="audit-email-msg" id="audit-email-msg"></span>
    `;
    ctaGroup.appendChild(wrap);

    document.getElementById('audit-email-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('audit-email-input').value.trim();
      const formEl = document.getElementById('audit-email-form');
      const btn = formEl.querySelector('button');
      const msgEl = document.getElementById('audit-email-msg');
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
            health_score: data.healthScore,
            letter_grade: data.letterGrade,
            findings: data.allFindings,
          }),
        });
        const result = await res.json();

        if (result.success) {
          formEl.style.display = 'none';
          msgEl.textContent = 'Sent. Check your inbox.';
          msgEl.classList.add('active', 'ok');
        } else {
          msgEl.textContent = result.message || "Couldn't send that right now. Try WhatsApp instead.";
          msgEl.classList.add('active', 'warn');
          btn.textContent = 'Email Me This';
          btn.disabled = false;
        }
      } catch (err) {
        msgEl.textContent = "Couldn't send that right now. Try WhatsApp instead.";
        msgEl.classList.add('active', 'warn');
        btn.textContent = 'Email Me This';
        btn.disabled = false;
      }
    });
  }

  function setCtaLinks(value, topFinding, data) {
    const waText = topFinding
      ? `Hi WebCliniQ. I ran an audit for "${value}". Top issue: ${topFinding.text} I'd like to get this fixed.`
      : `Hi WebCliniQ. I ran an audit for "${value}" and wanted to follow up.`;
    if (ctaLink) ctaLink.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;
  }

  function applyCtaMode(mode, label) {
    ctaGroup.classList.remove('hidden', 'soft');
    if (mode === 'hidden') ctaGroup.classList.add('hidden');
    if (mode === 'soft') ctaGroup.classList.add('soft');
    if (ctaLink && label) ctaLink.textContent = label;
  }

  function buildNudge(data, value) {
    const isMissingWebsite = data.hadWebsite === false;
    const label = isMissingWebsite ? 'Add your website for a fuller picture' : 'Add your business name for a Google check';
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
      againBox.innerHTML = `<span>Checked a few already? Message us for more.</span>`;
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
    const list = data.allFindings || [];
    const incomplete = data.hadWebsite === false || data.hadBusinessName === false;

    if (data.isHealthcare === false) {
      mismatchBox.innerHTML = `<span class="audit-mismatch-label">Heads up</span><span>WebCliniQ is built for healthcare practices. We'll still show you what we found.</span>`;
      mismatchBox.classList.add('active');
    }
    if (data.mismatch) {
      mismatchBox.innerHTML = `<span class="audit-mismatch-label">Double-check</span><span>${data.mismatch}</span>`;
      mismatchBox.classList.add('active');
    }

    let topFinding = null;
    let listToShow = list;
    if (list.length && list[0].flag === 'warn') {
      topFinding = list[0];
      listToShow = list.slice(1);
      urgentBox.innerHTML = `<span class="audit-urgent-label">Most Urgent</span><span>${topFinding.text}</span>`;
      urgentBox.classList.add('active');
    }

    findingsList.innerHTML = '';
    listToShow.forEach((f, i) => {
      const li = document.createElement('li');
      const categoryTag = f.category ? `<span class="finding-category">${f.category}</span>` : '';
      li.innerHTML = `<span class="vitals-flag ${f.flag}">${f.flag === 'warn' ? 'Flag' : 'Clear'}</span><span>${categoryTag}${f.text}</span>`;
      findingsList.appendChild(li);
      setTimeout(() => li.classList.add('in'), i * 140);
    });

    const remaining = listToShow.filter(f => f.flag === 'warn').length;
    if (summary && data.healthScore != null) {
      summary.innerHTML = `<span class="audit-score-badge">Score: ${data.healthScore}/100</span><span class="audit-grade-pill ${gradeClass(data.letterGrade)}">${data.letterGrade}</span>${remaining > 0 ? `<span class="audit-extra-pill">${remaining} more issue${remaining === 1 ? '' : 's'}</span>` : ''}`;
    }

    setCtaLinks(value, topFinding, data);

    const hasAnyWarn = list.some(f => f.flag === 'warn');
    if (incomplete) {
      applyCtaMode('hidden');
    } else if (data.mismatch) {
      applyCtaMode('soft', 'Message Us on WhatsApp');
    } else if (!hasAnyWarn) {
      applyCtaMode('soft', 'Questions? Message Us');
    } else {
      applyCtaMode('primary', 'Message Us About These Issues');
    }

    if (incomplete) {
      buildNudge(data, value);
    } else {
      buildAgainLink();
      renderEmailCapture(value, data);
    }

    results.classList.add('active');
  }

  async function runAudit(value) {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      resetPanels();
      results.classList.add('active');
      if (summary) summary.textContent = "You've checked a few things already. Give it a bit, then try again, or message us directly.";
      ctaGroup.classList.add('hidden');
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
        results.classList.add('active');
        if (summary) summary.textContent = data.message;
        ctaGroup.classList.add('hidden');
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

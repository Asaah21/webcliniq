document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initReveal();
  initFAQ();
  initAuditBar();
});

function initNav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => links.classList.toggle('open'));
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
}

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

  function setCtaLinks(value, topFinding, healthScore) {
    const scoreText = healthScore ? `Score: ${healthScore}/100. ` : '';
    const issueText = topFinding ? `Top issue: ${topFinding.text}` : 'I would like to review the diagnostic findings.';
    const waText = `Hi WebCliniQ, I ran a diagnostic for "${value}". ${scoreText}${issueText} How fast can we resolve this?`;
    
    if (ctaLink) {
      ctaLink.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;
    }

    const emailLink = document.getElementById('audit-cta-email-link');
    if (emailLink) {
      const emailSubject = `Diagnostic Report Request: ${value}`;
      const emailBody = `Hi WebCliniQ,\n\nI ran an audit for "${value}".\nPractice Health Score: ${healthScore || 'N/A'}/100\n${issueText}\n\nPlease email me the full diagnostic breakdown.`;
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
    const label = isMissingWebsite ? "Add your website URL for mobile speed & security checks" : "Add your clinic name for a Google Maps check";
    const placeholder = isMissingWebsite ? 'yourclinic.com' : 'Your Practice Name';

    nudgeBox.innerHTML =
      `<p class="audit-nudge-label">${label}</p>
       <form class="audit-nudge-form" id="audit-nudge-form">
         <input type="text" id="audit-nudge-input" placeholder="${placeholder}">
         <button type="submit" class="btn btn-outline">Analyze Both</button>
       </form>
       <span class="audit-nudge-skip" id="audit-nudge-skip">Skip. Message directly on WhatsApp.</span>`;

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
        applyCtaMode('soft', 'Chat on WhatsApp');
      });
    }
  }

  function buildAgainLink() {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      againBox.innerHTML = `<span>Checked multiple practices? Message us directly for bulk reviews.</span>`;
      return;
    }
    againBox.innerHTML = `<a id="audit-again-link" style="cursor:pointer; text-decoration:underline;">Check another practice</a>`;
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
    const topList = data.topFindings || (data.findings ? data.findings.slice(0, 3) : []);
    const additional = data.additionalCount !== undefined
      ? data.additionalCount
      : Math.max(0, (data.allFindings || data.findings || []).length - topList.length);
    const incomplete = data.hadWebsite === false || data.hadBusinessName === false;

    if (data.mismatch) {
      mismatchBox.innerHTML = `<span class="audit-mismatch-label">Notice</span><span>${data.mismatch}</span>`;
      mismatchBox.classList.add('active');
    }

    const topFinding = topList.find(f => f.flag === 'warn') || topList[0];
    if (!data.alreadyChecked && topFinding && topFinding.flag === 'warn') {
      urgentBox.innerHTML = `<span class="audit-urgent-label">Urgent Fix Required</span><span>${topFinding.text}</span>`;
      urgentBox.classList.add('active');
    }

    findingsList.innerHTML = '';
    topList.forEach((f, i) => {
      const li = document.createElement('li');
      const flagText = f.flag === 'warn' ? 'Flag' : 'Passed';
      const categoryTag = f.category ? `<strong style="margin-right:4px;">[${f.category}]</strong>` : '';
      
      li.innerHTML = `<span class="vitals-flag ${f.flag}">${flagText}</span><span>${categoryTag}${f.text}</span>`;
      findingsList.appendChild(li);
      setTimeout(() => li.classList.add('in'), i * 140);
    });

    if (summary) {
      if (data.alreadyChecked) {
        summary.textContent = '';
      } else {
        const scoreBadge = data.healthScore ? `<strong>Health Score: ${data.healthScore}/100</strong>` : '';
        const extraPill = additional > 0 
          ? ` <span class="additional-pill" style="opacity:0.85; margin-left:8px;">(+${additional} more checks completed)</span>` 
          : '';
        summary.innerHTML = `${scoreBadge}${extraPill}`;
      }
    }

    setCtaLinks(value, topFinding, data.healthScore);

    const hasAnyWarn = (data.allFindings || data.findings || []).some(f => f.flag === 'warn');
    if (data.alreadyChecked) {
      applyCtaMode('soft', 'Chat on WhatsApp');
    } else if (incomplete) {
      applyCtaMode('hidden');
    } else if (data.mismatch) {
      applyCtaMode('soft', 'Chat on WhatsApp');
    } else if (!hasAnyWarn) {
      applyCtaMode('soft', 'Questions? Contact Us');
    } else {
      applyCtaMode('primary', 'Fix Top Issues via WhatsApp');
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
      showSoftStop("You have reached the limit of quick checks for this session. Send a WhatsApp message to run full practice diagnostics.");
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
        showError(data.error || 'Diagnostic service error. Please try again.');
        return;
      }

      if (data.softStop) {
        showSoftStop(data.message || "Multiple checks detected recently. Please wait a few minutes before testing another domain.");
        return;
      }

      renderResults(data, value);
    } catch (err) {
      loading.classList.remove('active');
      showError('Unable to connect to the WebCliniQ diagnostic engine.');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('audit-input');
    const value = input.value.trim();
    if (value) runAudit(value);
  });
}
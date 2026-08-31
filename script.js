document.addEventListener('DOMContentLoaded', () => {
  initAuditBar();
});

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
  let auditRunCount = 0;
  let loadingInterval;

  const loadingMessages = [
    "Initializing secure connection to target domain...",
    "Analyzing mobile core Web Vitals & patient drop-off speed...",
    "Querying Google Maps API for local practice authority...",
    "Compiling healthcare conversion and trust metrics..."
  ];

  function startLoadingTicker() {
    loading.classList.add('active');
    const textEl = loading.querySelector('span') || loading;
    let step = 0;
    textEl.textContent = loadingMessages[0];
    
    loadingInterval = setInterval(() => {
      step++;
      if (step < loadingMessages.length) {
        textEl.textContent = loadingMessages[step];
      }
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
    urgentBox.classList.remove('active'); 
    urgentBox.innerHTML = '';
    mismatchBox.classList.remove('active'); 
    mismatchBox.innerHTML = '';
    ctaGroup.classList.remove('hidden', 'soft');
    
    const existingEmailCta = document.getElementById('audit-email-capture');
    if (existingEmailCta) existingEmailCta.remove();
  }

  function renderEmailCapture(value, healthScore) {
    const emailWrapper = document.createElement('div');
    emailWrapper.id = 'audit-email-capture';
    emailWrapper.style.marginTop = '15px';
    emailWrapper.innerHTML = `
      <p style="font-size: 0.88rem; color: #4a5568; margin-bottom: 8px;">Want the complete detailed diagnostic report?</p>
      <form id="audit-email-form" style="display: flex; gap: 8px;">
        <input type="email" id="audit-email-input" placeholder="Practice Email Address" required style="flex: 1; padding: 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 0.9rem;">
        <button type="submit" class="btn" style="padding: 10px 16px; background: #2b6cb0; color: #fff; border: none; border-radius: 6px; cursor: pointer;">Send PDF</button>
      </form>
      <span id="audit-email-msg" style="display: none; font-size: 0.85rem; color: #38a169; margin-top: 6px;">Report request received! We'll email it shortly.</span>
    `;
    ctaGroup.appendChild(emailWrapper);

    document.getElementById('audit-email-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('audit-email-input').value;
      const btn = e.target.querySelector('button');
      btn.textContent = 'Sending...';
      btn.disabled = true;

      try {
        await fetch('/.netlify/functions/audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'capture_email', email, search_query: value, health_score: healthScore }),
        });
        document.getElementById('audit-email-form').style.display = 'none';
        document.getElementById('audit-email-msg').style.display = 'block';
      } catch (err) {
        btn.textContent = 'Failed. Try WhatsApp';
      }
    });
  }

  function renderResults(data, value) {
    const topList = data.topFindings || (data.allFindings ? data.allFindings.slice(0, 3) : []);
    const additional = data.additionalCount !== undefined ? data.additionalCount : Math.max(0, (data.allFindings || []).length - topList.length);

    if (data.isHealthcare === false) {
      mismatchBox.innerHTML = `<span class="audit-mismatch-label">Notice</span><span>WebCliniQ is built for healthcare practices. Running general diagnostic...</span>`;
      mismatchBox.classList.add('active');
    }

    if (data.mismatch) {
      mismatchBox.innerHTML = `<span class="audit-mismatch-label">Notice</span><span>${data.mismatch}</span>`;
      mismatchBox.classList.add('active');
    }

    const topFinding = topList.find(f => f.flag === 'warn') || topList[0];
    if (topFinding && topFinding.flag === 'warn') {
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
      const gradeColor = data.letterGrade === 'A' || data.letterGrade === 'B' ? '#38a169' : (data.letterGrade === 'C' ? '#d69e2e' : '#e53e3e');
      const scoreBadge = data.healthScore ? `<strong>Health Score: ${data.healthScore}/100</strong> <span style="margin-left: 8px; font-weight: bold; padding: 2px 8px; background: ${gradeColor}; color: white; border-radius: 4px;">Grade: ${data.letterGrade}</span>` : '';
      const extraPill = additional > 0 ? `<span class="additional-pill" style="display:inline-block; margin-left:10px; padding:3px 9px; background:#edf2f7; border-radius:12px; font-weight:600; font-size:0.85rem; color:#2d3748;">+${additional} more findings</span>` : '';
      summary.innerHTML = `${scoreBadge}${extraPill}`;
    }

    const waText = `Hi WebCliniQ, I ran an audit for "${value}". Score: ${data.healthScore}/100 (Grade ${data.letterGrade}). Primary Flag: ${topFinding ? topFinding.text : 'N/A'}. How fast can we fix this?`;
    if (ctaLink) ctaLink.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;

    // Inject Email Capture Form
    renderEmailCapture(value, data.healthScore);

    ctaGroup.classList.remove('hidden', 'soft');
    if ((data.allFindings || []).some(f => f.flag === 'warn')) {
      if (ctaLink) ctaLink.textContent = 'Fix Top Issues via WhatsApp';
    } else {
      ctaGroup.classList.add('soft');
      if (ctaLink) ctaLink.textContent = 'Questions? Contact Us';
    }

    if (data.hadWebsite === false || data.hadBusinessName === false) {
      const label = data.hadWebsite === false ? "Add website URL for speed checks" : "Add clinic name to verify Google Maps";
      nudgeBox.innerHTML = `<form id="audit-nudge-form" style="margin-top: 15px; display:flex; gap:8px;"><input type="text" id="audit-nudge-input" placeholder="${label}" style="flex:1; padding:10px; border:1px solid #cbd5e0; border-radius:6px;"><button type="submit" class="btn btn-outline" style="padding:10px;">Analyze Both</button></form>`;
      document.getElementById('audit-nudge-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const extra = document.getElementById('audit-nudge-input').value.trim();
        if (extra) runAudit(`${value}, ${extra}`);
      });
    }

    results.classList.add('active');
  }

  async function runAudit(value) {
    if (auditRunCount >= 3) return; 
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
        errorBox.querySelector('p').textContent = data.error || 'Service error. Try again.';
        errorBox.classList.add('active');
        return;
      }

      if (data.softStop) {
        results.classList.add('active');
        summary.textContent = data.message;
        ctaGroup.classList.add('hidden');
        return;
      }
      renderResults(data, value);
    } catch (err) {
      stopLoadingTicker();
      errorBox.querySelector('p').textContent = 'Unable to connect to diagnostic engine.';
      errorBox.classList.add('active');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('audit-input').value.trim();
    if (val) runAudit(val);
  });
}
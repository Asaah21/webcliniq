document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initReveal();
  initFAQ();
  initAuditBar();
  initDemoPanel();
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
  const showAll = () => items.forEach(el => el.classList.add('in'));

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) {
    showAll();
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
  // Safety net: nothing stays invisible for long if the observer misfires.
  setTimeout(showAll, 2500);
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

/* ---- score dial (shared: real results panel + hero demo) ---- */
function renderDial(score, container) {
  const target_el = container || document.getElementById('audit-dial');
  if (!target_el) return;
  const r = 42;
  const circ = 2 * Math.PI * r;
  const target = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  target_el.innerHTML =
    `<svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">
       <circle class="audit-dial-track" cx="48" cy="48" r="${r}"></circle>
       <circle class="audit-dial-arc" cx="48" cy="48" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"></circle>
     </svg>
     <span class="audit-dial-num">${score}</span>`;
  const arc = target_el.querySelector('.audit-dial-arc');
  if (arc) {
    if (prefersReducedMotion()) arc.style.strokeDashoffset = target;
    else setTimeout(() => { arc.style.strokeDashoffset = target; }, 40);
  }
}

/* ============================================
   Hero demo panel
   ============================================ */
const DEMO_PRACTICE = {
  name: 'Sample Dental Clinic',
  website: 'sample-clinic.example',
  score: 67,
  summary: 'This practice has a Google listing but three gaps that are likely costing new patients right now. With 14 reviews against a local median of 51, the listing is thin by Accra standards. Getting the tap-to-call number in place and pushing reviews above 40 would close the two biggest gaps.',
  findings: [
    {
      key: 'maps-rank', severity: 'high',
      title: 'Google Maps ranking', value: '#8 nearby',
      consequence: "Most patients searching Google Maps in Accra won't scroll past the top 5.",
      event: 'listing'
    },
    {
      key: 'reviews-vs-area', severity: 'high',
      title: 'Google reviews', value: '14 · 4.6★',
      benchmark: 'nearby: 51, 43, 38',
      event: 'listing'
    },
    {
      key: 'gbp-description', severity: 'medium',
      title: 'Google profile description', value: 'not written',
      consequence: 'Space to tell patients what you treat, left blank.',
      event: 'listing'
    },
    {
      key: 'tap-to-call', severity: 'medium',
      title: 'One-tap calling', value: 'missing',
      consequence: 'Mobile patients have to copy the number out by hand.',
      event: 'website'
    },
    {
      key: 'phone-speed', severity: 'high',
      title: 'Mobile load speed', value: '4.2s',
      consequence: 'Most patients will leave before it opens.',
      event: 'pagespeed'
    },
  ]
};

// Three states: 'playing' | 'held' | 'dimmed' | 'gone'
let demoState = 'playing';
let demoTimeouts = []; // store all setTimeout IDs for cancellation

function initDemoPanel() {
  const demoPanel    = document.getElementById('audit-demo');
  const checkingEl   = document.getElementById('demo-checking');
  const checkingText = document.getElementById('demo-checking-text');
  const resultEl     = document.getElementById('demo-result');
  const matchEl      = document.getElementById('demo-match');
  const dialEl       = document.getElementById('demo-dial');
  const scoreEl      = document.getElementById('demo-score');
  const contextEl    = document.getElementById('demo-context');
  const findingsList = document.getElementById('demo-findings');
  const moreEl       = document.getElementById('demo-more');
  if (!demoPanel) return;

  const CHECKING_MESSAGES = [
    'Checking your Google presence…',
    'Analysing your website…',
    'Comparing against nearby practices…',
    'Putting your results together…',
  ];

  function demoFindingRow(f, i) {
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
    // Animate in after a short delay
    if (prefersReducedMotion()) {
      li.classList.add('in');
    } else {
      const t = setTimeout(() => li.classList.add('in'), 40);
      demoTimeouts.push(t);
    }
  }

  function schedule(ms, fn) {
    const t = setTimeout(fn, ms);
    demoTimeouts.push(t);
  }

  function resetDemo() {
    findingsList.innerHTML = '';
    matchEl.hidden = true;
    resultEl.hidden = true;
    if (contextEl) contextEl.hidden = true;
    if (scoreEl) scoreEl.innerHTML = '';
    if (dialEl) dialEl.innerHTML = '';
    if (checkingEl) checkingEl.hidden = false;
    if (checkingText) checkingText.textContent = CHECKING_MESSAGES[0];
  }

  function playDemo() {
    demoState = 'playing';
    demoTimeouts = [];

    // 0.0s — pulse already visible via CSS on .demo-panel.active
    // checking state visible, result hidden (already in HTML)

    // 0.8s — match line
    schedule(800, () => {
      if (demoState !== 'playing') return;
      const site = DEMO_PRACTICE.website
        ? ` &rarr; <b class="demo-redact">${escapeHtml(DEMO_PRACTICE.website)}</b>` : '';
      matchEl.innerHTML = `Matched <b class="demo-redact">${escapeHtml(DEMO_PRACTICE.name)}</b>${site}`;
      matchEl.hidden = false;
      resultEl.hidden = false;
      if (checkingText) checkingText.textContent = CHECKING_MESSAGES[1];
    });

    // 2.0s — listing findings, one by one (400ms apart)
    const listingFindings = DEMO_PRACTICE.findings.filter(f => f.event === 'listing');
    listingFindings.forEach((f, i) => {
      schedule(2000 + i * 400, () => {
        if (demoState !== 'playing') return;
        demoFindingRow(f, i);
      });
    });

    // 3.5s — checking text update
    schedule(3500, () => {
      if (demoState !== 'playing') return;
      if (checkingText) checkingText.textContent = CHECKING_MESSAGES[2];
    });

    // 4.0s — website finding
    const websiteFindings = DEMO_PRACTICE.findings.filter(f => f.event === 'website');
    websiteFindings.forEach((f, i) => {
      schedule(4000 + i * 400, () => {
        if (demoState !== 'playing') return;
        demoFindingRow(f, listingFindings.length + i);
      });
    });

    // 5.0s — checking text update
    schedule(5000, () => {
      if (demoState !== 'playing') return;
      if (checkingText) checkingText.textContent = CHECKING_MESSAGES[3];
    });

    // 5.4s — pagespeed finding
    const speedFindings = DEMO_PRACTICE.findings.filter(f => f.event === 'pagespeed');
    speedFindings.forEach((f, i) => {
      schedule(5400 + i * 400, () => {
        if (demoState !== 'playing') return;
        demoFindingRow(f, listingFindings.length + websiteFindings.length + i);
      });
    });

    // 6.2s — summary paragraph
    schedule(6200, () => {
      if (demoState !== 'playing') return;
      if (contextEl) {
        contextEl.textContent = DEMO_PRACTICE.summary;
        contextEl.hidden = false;
      }
    });

    // 7.0s — dial + score, pulse hides, demo HELD
    schedule(7000, () => {
      if (demoState !== 'playing') return;
      demoState = 'held';
      if (checkingEl) checkingEl.hidden = true;
      if (scoreEl) {
        scoreEl.innerHTML = `<b>${DEMO_PRACTICE.score}</b> / 100 &middot; <span class="demo-redact">${escapeHtml(DEMO_PRACTICE.name)}</span>`;
      }
      if (dialEl) renderDial(DEMO_PRACTICE.score, dialEl);
      if (prefersReducedMotion()) return;
      if (!demoPanel.style.minHeight) demoPanel.style.minHeight = demoPanel.offsetHeight + 'px';
      schedule(6000, () => {
        if (demoState !== 'held') return;
        resultEl.style.transition = 'opacity 300ms ease';
        resultEl.style.opacity = '0';
        schedule(320, () => {
          if (demoState !== 'held') return;
          resetDemo();
          resultEl.style.opacity = '';
          playDemo();
        });
      });
    });
  }

  // Expose stopDemo globally so initAuditBar can call it
  window.stopDemo = function stopDemo() {
    // Cancel all pending timeouts
    demoTimeouts.forEach(clearTimeout);
    demoTimeouts = [];
    demoState = 'dimmed';
    // Dim the panel — CSS handles the visual via data-state
    if (demoPanel) demoPanel.dataset.state = 'dimmed';
  };

  // Expose crossfadeToReal globally for use when first stream event arrives
  window.crossfadeToReal = function crossfadeToReal() {
    if (demoState === 'gone') return;
    const realPanel = document.getElementById('audit-results');
    if (!realPanel || !demoPanel) return;

    demoState = 'gone';
    // Show real panel, crossfade demo out
    realPanel.hidden = false;
    if (!realPanel.classList.contains('active')) realPanel.classList.add('active');
    realPanel.style.opacity = '0';
    demoPanel.style.transition = 'opacity 150ms ease';
    realPanel.style.transition = 'opacity 150ms ease';

    requestAnimationFrame(() => {
      demoPanel.style.opacity = '0';
      realPanel.style.opacity = '1';
      setTimeout(() => {
        demoPanel.hidden = true;
        demoPanel.style.transition = '';
        realPanel.style.transition = '';
        realPanel.style.opacity = '';
      }, 160);
    });
  };

  playDemo();
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
  const contextEl = document.getElementById('audit-context');
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
    'Checking your Google presence…',
    'Analysing your website…',
    'Comparing against nearby practices…',
    'Putting your results together…',
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
    results.hidden = true;
    results.style.opacity = '';
    [matchEl, noticeEl, moreEl, againEl, contextEl].forEach(el => { if (el) { el.hidden = true; el.innerHTML = ''; } });
    if (findingsList) findingsList.innerHTML = '';
    if (dialEl) dialEl.innerHTML = '';
    if (scoreEl) scoreEl.innerHTML = '';
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

  /* ---- one finding row ---- */
  function findingRow(f, i) {
    const urgent = f.severity === 'critical' || f.severity === 'high';
    const clear = f.severity === 'clear';
    const li = document.createElement('li');
    li.className = 'af-row';
    const fig = f.value
      ? `<span class="af-fig">${escapeHtml(f.value)}${f.benchmark ? `<br><span class="af-bench">vs ${escapeHtml(f.benchmark)}</span>` : ''}</span>`
      : '';
    li.innerHTML =
      `<span class="af-dot${urgent ? ' urgent' : clear ? ' clear' : ''}"></span>
       <span class="af-body">
         <span class="af-title">${escapeHtml(f.title)}</span>
         ${f.consequence ? `<span class="af-desc">${escapeHtml(f.consequence)}</span>` : ''}
       </span>
       ${fig}`;
    li.dataset.key = f.key;
    findingsList.appendChild(li);
    if (prefersReducedMotion()) li.classList.add('in');
    else setTimeout(() => li.classList.add('in'), 80 + i * 90);
  }

  /* ---- CTA ladder: email report -> WhatsApp ---- */
  function renderCta(value, topFix, data) {
    const waText = topFix
      ? `Hi Emmanuel. I ran a check for "${value}". The main thing flagged: ${topFix.title}${topFix.value ? ` (${topFix.value})` : ''}. I'd like to get this sorted.`
      : `Hi Emmanuel. I ran a check for "${value}" and wanted to follow up.`;
    const wa = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waText)}`;

    ctaEl.innerHTML =
      `<form class="audit-email-form" id="audit-email-form">
         <input type="email" id="audit-email-input" placeholder="you@yourpractice.com" required aria-label="Your email">
         <button type="submit" class="btn btn-primary">Email me my full report</button>
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
          findings: data.findings,
          ai_summary: data.aiSummary || null,
          audit_id: data.auditId || null,
          public_id: data.publicId || null,
        }),
      });
      const result = await res.json();
      if (result.success) {
        formEl.hidden = true;
        msg.textContent = 'Sent. Check your inbox.';
        msg.className = 'audit-email-msg ok';
        msg.hidden = false;
      } else {
        msg.textContent = result.message || "Couldn't send that right now. Message on WhatsApp instead.";
        msg.className = 'audit-email-msg warn';
        msg.hidden = false;
        btn.textContent = 'Email me my full report';
        btn.disabled = false;
      }
    } catch (err) {
      msg.textContent = "Couldn't send that right now. Message on WhatsApp instead.";
      msg.className = 'audit-email-msg warn';
      msg.hidden = false;
      btn.textContent = 'Email me my full report';
      btn.disabled = false;
    }
  }

  function buildAgainLink() {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      againEl.innerHTML = '<span>Checked a few already? Message me for more.</span>';
    } else {
      againEl.innerHTML = '<a id="audit-again-link">Check another practice</a>';
      const link = document.getElementById('audit-again-link');
      if (link) link.addEventListener('click', resetToForm);
    }
    againEl.hidden = false;
  }

  async function runAudit(value) {
    if (auditRunCount >= MAX_RUNS_PER_VISIT) {
      resetPanels();
      if (typeof window.crossfadeToReal === 'function') window.crossfadeToReal();
      contextEl.textContent = "You've checked a few things already. Give it a bit, then try again, or message me directly.";
      contextEl.hidden = false;
      results.classList.add('active');
      return;
    }
    auditRunCount++;

    form.classList.add('hidden');
    if (hint) hint.style.display = 'none';
    resetPanels();
    startLoadingTicker(); // still shows until 'match' event arrives

    // Local state accumulated across events
    const auditState = {
      allFindings: [],
      matched: null,
      score: null,
      moreCount: 0,
      publicId: null,
      auditId: null,
      city: null,
      prominenceRank: null,
      summary: null,
      sharpened: {},
      mismatch: null,
      screenshot: null,
      isHealthcare: null,
      hadWebsite: false,
    };

    try {
      const response = await fetch('/api/audit-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });

      if (!response.ok || !response.body) {
        stopLoadingTicker();
        showError('Something went wrong reaching the audit service.');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete chunk
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(part.slice(6));
            handleStreamEvent(event, value, auditState);
          } catch (e) {
            console.error('Stream parse error:', e);
          }
        }
      }
    } catch (err) {
      stopLoadingTicker();
      showError('Something went wrong reaching the audit service.');
    }
  }

  function handleStreamEvent(event, inputValue, state) {
    switch (event.type) {

      case 'searching':
        // Panel is already hidden behind loading ticker — no UI change needed yet
        break;

      case 'match':
        stopLoadingTicker();
        // First genuine stream signal — crossfade the hero demo out.
        if (typeof window.crossfadeToReal === 'function') window.crossfadeToReal();
        results.classList.add('active');
        state.matched = event;
        if (matchEl && event.name) {
          const site = event.website
            ? ` &rarr; <b>${escapeHtml(stripProto(event.website))}</b>` : '';
          matchEl.innerHTML = `Matched <b>${escapeHtml(event.name)}</b>${site}. <a id="audit-notyou">Not you?</a>`;
          matchEl.hidden = false;
          const notYou = document.getElementById('audit-notyou');
          if (notYou) notYou.addEventListener('click', resetToForm);
        }
        break;

      case 'listing':
      case 'website':
      case 'pagespeed':
        // Append findings as they arrive
        (event.findings || []).forEach(f => {
          // Only show critical/high/medium — not clear or low (those wait for complete)
          if (['critical','high','medium'].includes(f.severity)) {
            state.allFindings.push(f);
            findingRow(f, state.allFindings.length - 1);
          }
        });
        break;

      case 'enrichment':
        state.summary = event.summary;
        state.sharpened = event.sharpened || {};

        // Patch already-rendered findings with sharpened consequences
        if (event.sharpened) {
          document.querySelectorAll('.af-row').forEach(row => {
            const key = row.dataset.key;
            if (key && event.sharpened[key]) {
              const desc = row.querySelector('.af-desc');
              if (desc) desc.textContent = event.sharpened[key];
            }
          });
        }

        // Show AI summary paragraph in position B (audit-context)
        if (event.summary && contextEl) {
          contextEl.textContent = event.summary;
          contextEl.hidden = false;
        }
        break;

      case 'complete':
        // Merge final state
        Object.assign(state, {
          score: event.score,
          moreCount: event.moreCount,
          city: event.city,
          prominenceRank: event.prominenceRank,
          publicId: event.publicId,
          auditId: event.auditId,
          mismatch: event.mismatch,
          screenshot: event.screenshot,
          isHealthcare: event.isHealthcare,
          hadWebsite: event.hadWebsite,
        });

        // Re-render findings in correct sorted order
        if (findingsList) findingsList.innerHTML = '';
        const finalShown = (event.topFindings || []).slice(0, 5);
        const clears = (event.allFindings || []).filter(f => f.severity === 'clear').slice(0, 2);
        [...finalShown, ...clears].forEach((f, i) => findingRow(f, i));

        // Score
        if (scoreEl) {
          const name = (event.matched && event.matched.name) || inputValue || '';
          scoreEl.innerHTML = `<b>${event.score != null ? event.score : '&ndash;'}</b> / 100${name ? ` &middot; ${escapeHtml(name)}` : ''}`;
        }

        // Dial animates here
        if (event.score != null) renderDial(event.score);

        // More count
        if (event.moreCount > 0 && moreEl) {
          moreEl.innerHTML = `<b>${event.moreCount} more ${event.moreCount === 1 ? 'issue' : 'issues'} found</b>. Email yourself the full report below to see them all, each with the fix.`;
          moreEl.hidden = false;
        }

        // Notice (non-healthcare / mismatch)
        let notice = '';
        if (event.isHealthcare === false) notice = "WebCliniQ is built for healthcare practices, but here's what the check found anyway.";
        if (event.mismatch) notice = event.mismatch;
        if (notice && noticeEl) { noticeEl.textContent = notice; noticeEl.hidden = false; }

        // CTA + again link
        const topFix = finalShown.find(f => f.severity === 'critical' || f.severity === 'high') || finalShown[0] || null;
        renderCta(inputValue, topFix, {
          score: event.score,
          findings: event.allFindings,
          aiSummary: state.summary,
          auditId: event.auditId,
          publicId: event.publicId,
        });
        buildAgainLink();
        break;

      case 'error':
        stopLoadingTicker();
        showError(event.message || 'Something went wrong. Try again.');
        break;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('audit-input').value.trim();
    if (!val) return;
    // Stop demo immediately on submit
    if (typeof window.stopDemo === 'function') window.stopDemo();
    runAudit(val);
  });
}

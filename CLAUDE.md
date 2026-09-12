# WebCliniQ — Claude Code Configuration

## Project overview
WebCliniQ is Emmanuel Asaah Alemya's web services business — targeting healthcare practices only.
Services: website builds, speed optimisation, Google Business Profile, review management.
The built-in audit tool is a lead generation mechanism, not the product itself.
Pre-revenue. Every session should produce working, tested code — not experiments.

## Current state (read this first)
As of now, **`netlify/functions/audit.js` is the entire audit engine** — Places, PageSpeed,
website content checks, Gemini enrichment, scoring, and email capture all live in this one
Node function (`exports.handler`, routed on `payload.action`). It runs synchronously and
returns one JSON response; it does not stream.

**There is no `netlify/edge-functions/` directory yet.** The Deno streaming edge function
described below, under "Target architecture," has not been built. Do not create it, and do
not assume it exists, unless a task explicitly asks you to start that migration.

## Stack
- Frontend: Vanilla JS, plain HTML/CSS — no frameworks
- Functions: Netlify Functions (Node.js) — currently the whole audit engine + email capture
- Edge Functions: Netlify Edge Functions (Deno) — **planned**, not yet built (see Target architecture)
- Database: Supabase
- Email: Resend
- AI: Gemini Flash (via REST)
- APIs: Google Places, PageSpeed Insights, Geocoding
- Deploy: Netlify

## Target architecture (future refactor — not yet built)
The intent is to eventually split the audit engine out into a streaming Deno edge function,
leaving the Node function for email capture only:

| File | Job | Status |
|---|---|---|
| `netlify/edge-functions/audit.js` | Streaming audit (Deno) | Not built |
| `netlify/functions/audit.js` | Email capture only (Node) | Not yet split — currently also runs the whole audit |
| `script.js` | Frontend audit UI and stream reader | Currently reads one JSON response, not a stream |
| `styles.css` | All styling | Current |
| `index.html` | Structure and copy only | Current |

Until this migration actually happens, treat `netlify/functions/audit.js` as the single
source of truth for audit logic — new checks, scoring changes, and enrichment work all go
there, not into a `netlify/edge-functions/audit.js` that doesn't exist.

## Session rules
- One file per session unless the task explicitly requires multiple
- After any change, show only the modified function — not the whole file
- Never rewrite what wasn't asked to change
- If a change would affect another file, flag it and stop — don't touch the other file
- Before adding a check or field, grep for it first — this file has grown a lot; confirm it doesn't already exist under a different name before adding a duplicate

## Code rules
- No npm packages unless already in use — native fetch, crypto are available in both Node and Deno
- All API calls use fetchWithTimeout — never raw fetch
- Every new finding must follow the finding contract: key, domain, severity, title, value, consequence, fix
- Gemini calls degrade silently — any failure returns null, never breaks the audit
- Score starts at 85, deductions: critical −15, high −8, medium −4, no-website cap 45
- Stream events (searching, match, listing, website, pagespeed, enrichment, complete, error) are the planned shape for the future edge function — the current Node function does not emit these; it returns one JSON body

## Finding severity guide
| Severity | Deduction | When to use |
|---|---|---|
| critical | −15 | No website, no Google listing |
| high | −8 | Speed timeout, NAP mismatch, rank outside top 10, recency > 90 days |
| medium | −4 | Thin reviews, no social media, no GBP description, < 6 photos |
| low | 0 | Missing pages, minor copy issues |
| clear | 0 | Passing check — shown as reassurance |

## Env vars
- `GOOGLE_API_KEY` — Places, PageSpeed, Geocoding
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — database
- `GEMINI_API_KEY` — AI enrichment
- `RESEND_API_KEY` — email via Resend
- `FROM_EMAIL` — sender address
- `SITE_URL` — production URL
- `NOTIFY_EMAIL` — Emmanuel's email for lead alerts

## Deno vs Node — for the future edge-function migration only
Not relevant today — there is no Deno file in this project yet. Once
`netlify/edge-functions/audit.js` is actually created, it uses:
- `Deno.env.get('VAR')` not `process.env.VAR`
- `import { createClient } from 'npm:@supabase/supabase-js'`
- `export default async (request)` not `exports.handler`
- `await request.json()` not `JSON.parse(event.body)`
- No require() anywhere

## What not to do
- Do not add console.log statements beyond what already exists
- Do not install new npm packages without asking
- Do not change the finding contract shape
- Do not create `netlify/edge-functions/audit.js` or otherwise start the streaming migration unless explicitly asked to
- Do not rewrite the entire file to make a small change — use targeted edits
- Do not add comments explaining what the code does unless asked

## Verification step (always)
After every change, show:
1. The modified function only
2. One sentence confirming what changed and what was deliberately left alone

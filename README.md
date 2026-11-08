# Rolecraft

A private Software Engineer and Applied AI Engineer job-search workspace for Kenil Gopani. The application lives directly in this repository root.

## Features

- Save and edit roles from LinkedIn, Indeed, ZipRecruiter, Jobright, Jack & Jill AI, a16z, Wellfound, YC, or another source.
- Search and filter by role, location, work mode, sponsorship, work authorization, career fit, platform, and application status. Switch between list and board views.
- Track job links, application dates, deadlines, recruiter details, notes, and follow-ups.
- Import `.tex`, `.txt`, or `.md` resume source. Store and download the original without changing its whitespace, LaTeX commands, headings, or structure.
- Compare a pasted job description against eight engineering focus areas: production LLM applications, RAG, agents, evaluation, guardrails, observability, backend, and distributed systems.
- Export separate resume content priorities. Generate editable recruiter introduction and follow-up templates using only matching keyword evidence, with explicit placeholders for verified project results.
- Export calendar reminders (`.ics`) and workspace backups (`.json`); restore backups with validation and confirmation.
- Explore fictional sample roles in an isolated, unsaved demo workspace.

## Current behavior

Job sources are external shortcuts. Job links and descriptions are entered manually; this app does not scrape job platforms or automatically apply to roles. Resume comparison is transparent keyword matching, not semantic LLM analysis or an ATS score. Outreach uses templates, and messages are never sent automatically. Reminders appear in the app; export them to a calendar for notifications while the app is closed.

No personal resume or application records are committed to source control. The default workspace is empty. Data is stored in Cloudflare D1 under the signed-in visitor's Site-scoped identity, with optimistic concurrency checks to prevent stale-tab overwrites. Private hosting access is preserved.

## Development

Requires Node.js 22.13+.

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_keen_senator_kelly.sql
npm run dev -- --host 127.0.0.1
```

The dev server provides local mock sign-in on loopback. Hosted sign-in is handled by Sites; API routes require visitor identity. The local database is independent from production. Apply each local SQL migration once; publication applies production migrations automatically.

## Verification

```sh
npm run typecheck
npm test
# With the dev server and local database running:
npm run test:api
npm run build
```

Tests cover resume preservation, matching evidence, safe drafts, calendar exports, input validation, authentication, persistence, origin checks, and conflicting writes. API tests use only the local mock identity and restore the starting workspace after testing.

## Structure

- `app/page.tsx`: authenticated page entry.
- `components/dashboard.tsx`: interactive dashboard and workflows.
- `lib/workspace.ts`: schemas, matching, outreach, and calendar generation.
- `app/api/workspace/route.ts`: authenticated D1 persistence with revision checks.
- `db/schema.ts` and `drizzle/`: schema and migrations.
- `.openai/hosting.json`: existing private Site identity and storage binding.

## Git identity

Project commits use `Kenil Gopani <kenilgopani.dev@gmail.com>` without generated co-author attribution.

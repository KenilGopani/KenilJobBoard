import test from "node:test";
import assert from "node:assert/strict";
import {
  fillMissing,
  KEY_PRIORITY,
  keyRank,
  keysConflict,
  ingestPayloadSchema,
  ingestJobSchema,
  mergeProvenance,
  salaryLabel,
  statusUpdateSchema,
  toWorkspaceJob,
  MAX_IMPORT_JOBS,
} from "../lib/discovery.ts";
import { jobSchema } from "../lib/workspace.ts";

const at = "2026-11-15T12:00:00.000Z";
// A fictional CanonicalJob exactly as ApplyPilot sends it.
const canonical = {
  id: "job_0123456789abcdef",
  externalId: "in-5e409e577046abcd",
  title: "GenAI Engineer",
  company: "Contoso Analytics",
  location: "Austin, TX, USA",
  remoteType: "hybrid",
  description: "Build RAG pipelines.",
  source: "indeed",
  sourceUrl: "https://www.indeed.com/viewjob?jk=5e409e577046abcd",
  postedAt: "2026-11-12",
  salaryMin: 140000,
  salaryMax: 180000,
  salaryCurrency: "USD",
  salaryInterval: "yearly",
  employmentType: "fulltime",
  discoveredAt: at,
  provenance: [
    {
      provider: "indeed",
      site: "indeed",
      url: "https://www.indeed.com/viewjob?jk=5e409e577046abcd",
      applyUrl: "https://careers.contoso.example/jobs/123",
      externalId: "in-5e409e577046abcd",
      adapter: "jobspy",
      upstreamVersion: "python-jobspy@1.4.1",
      runId: "run_a",
      discoveredAt: at,
    },
  ],
  rawSource: { id: "in-5e409e577046abcd", site: "indeed" },
};
const run = {
  runId: "run_a",
  adapter: "jobspy",
  status: "ok",
  startedAt: at,
  finishedAt: at,
  metrics: { returned: 1 },
};

test("a canonical job from ApplyPilot is accepted as an import", () => {
  const parsed = ingestPayloadSchema.parse({ run, jobs: [canonical] });
  assert.deepEqual(parsed.jobs[0].rawSource, canonical.rawSource);
});

test("imports reject unsafe urls, missing provenance and oversized batches", () => {
  assert.equal(
    ingestJobSchema.safeParse({
      ...canonical,
      sourceUrl: "javascript:alert(1)",
    }).success,
    false,
  );
  assert.equal(
    ingestJobSchema.safeParse({ ...canonical, provenance: [] }).success,
    false,
  );
  assert.equal(
    ingestJobSchema.safeParse({ ...canonical, id: "123" }).success,
    false,
  );
  const many = Array.from({ length: MAX_IMPORT_JOBS + 1 }, () => canonical);
  assert.equal(
    ingestPayloadSchema.safeParse({ run, jobs: many }).success,
    false,
  );
});

test("provenance merging records new sightings once and keeps old ones", () => {
  const first = canonical.provenance;
  assert.deepEqual(mergeProvenance(first, first), first);
  const later = {
    ...first[0],
    runId: "run_b",
    discoveredAt: "2026-11-16T08:00:00.000Z",
  };
  const linkedin = {
    ...first[0],
    provider: "linkedin",
    site: "linkedin",
    url: "https://www.linkedin.com/jobs/view/1",
  };
  const merged = mergeProvenance(first, [later, linkedin, later]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], first[0]);
});

function detail(overrides = {}) {
  return {
    ...canonical,
    status: "new",
    location: canonical.location,
    sites: ["indeed"],
    firstSeenAt: at,
    lastSeenAt: at,
    promotedJobId: null,
    ...overrides,
  };
}

test("saving a discovered job creates a valid opportunity linked back to it", () => {
  const job = toWorkspaceJob(detail(), "saved", "2026-11-15");
  assert.equal(jobSchema.safeParse(job).success, true);
  assert.equal(job.status, "Saved");
  assert.equal(job.appliedAt, "");
  assert.equal(job.platform, "Indeed");
  assert.equal(job.workMode, "Hybrid");
  assert.equal(job.discoveredJobId, canonical.id);
  assert.equal(job.sponsorship, "Unknown", "never inferred from discovery");
  assert.equal(job.authorization, "Not specified");
  assert.match(job.notes, /Discovered via indeed on 2026-11-15/);
  assert.match(job.notes, /140,000–180,000 USD \/yearly/);
});

test("applying sets the stage and date; unmapped sources become Other", () => {
  const job = toWorkspaceJob(
    detail({ source: "glassdoor", remoteType: "unknown" }),
    "applied",
    "2026-11-15",
  );
  assert.equal(job.status, "Applied");
  assert.equal(job.appliedAt, "2026-11-15");
  assert.equal(job.platform, "Other");
  assert.equal(job.workMode, "Unknown");
});

test("long postings are trimmed to the workspace limits instead of failing", () => {
  const job = toWorkspaceJob(
    detail({ title: "T".repeat(300), description: "d".repeat(60000) }),
    "saved",
    "2026-11-15",
  );
  assert.equal(jobSchema.safeParse(job).success, true);
});

test("salary labels and status updates", () => {
  assert.equal(salaryLabel(detail({ salaryMin: null, salaryMax: null })), "");
  assert.equal(
    salaryLabel(
      detail({ salaryMin: 70, salaryMax: 70, salaryInterval: "hourly" }),
    ),
    "70 USD /hourly",
  );
  assert.equal(statusUpdateSchema.safeParse({ status: "skip" }).success, true);
  assert.equal(
    statusUpdateSchema.safeParse({ status: "Applied" }).success,
    false,
  );
});

test("dedup keys: strongest kind ranks first and conflicting opening ids block a merge", () => {
  assert.ok(keyRank("ats:greenhouse:1") < keyRank("cctl:a|b|c"));
  assert.ok(keyRank("id:job_1") < keyRank("url:https://x"));
  assert.equal(keyRank("ct:a|b"), KEY_PRIORITY.length, "weak kinds rank last");
  assert.ok(keysConflict(["ats:greenhouse:1"], ["ats:greenhouse:2"]));
  assert.ok(keysConflict(["req:acme:r-1"], ["req:acme:r-2"]));
  assert.ok(
    !keysConflict(["req:acme:r-1"], ["req:globex:r-2"]),
    "requisitions are per company",
  );
  assert.ok(!keysConflict(["ats:greenhouse:1"], ["ats:lever:9"]));
  assert.ok(!keysConflict(["cctl:a|b|c"], ["ats:greenhouse:2"]));
  assert.equal(
    ingestJobSchema.safeParse({ ...canonical, dedupKeys: ["ats:greenhouse:1"] })
      .success,
    true,
  );
  assert.equal(
    ingestJobSchema.safeParse({ ...canonical, dedupKeys: ["no-kind"] }).success,
    false,
  );
});

test("merging fills only missing fields and moves salary as one unit", () => {
  const existing = {
    location: "San Francisco, CA",
    postedAt: null,
    employmentType: null,
    description: null,
    remoteType: "unknown",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
  };
  assert.deepEqual(
    fillMissing(existing, {
      location: "Elsewhere",
      postedAt: "2026-11-01",
      description: "JD text",
      remoteType: "hybrid",
      salaryMin: 140000,
      salaryCurrency: "USD",
      salaryInterval: "yearly",
    }),
    {
      postedAt: "2026-11-01",
      description: "JD text",
      remoteType: "hybrid",
      salaryMin: 140000,
      salaryMax: null,
      salaryCurrency: "USD",
      salaryInterval: "yearly",
    },
  );
  assert.deepEqual(
    fillMissing(
      { ...existing, salaryMax: 150000, remoteType: "remote" },
      { salaryMin: 1, remoteType: "onsite" },
    ),
    {},
  );
});

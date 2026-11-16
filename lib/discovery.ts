import { z } from "zod";
import { newJob, type Job } from "./workspace.ts";

/**
 * Discovered jobs come from automated search (ApplyPilot: JobSpy, later
 * Career Ops). They live in their own inbox, separate from the workspace's
 * application stages: a discovered job is not an application until you save
 * or apply to it.
 */
export const discoveryStatuses = [
  "new",
  "review",
  "saved",
  "skip",
  "applied",
] as const;
export type DiscoveryStatus = (typeof discoveryStatuses)[number];

export const discoverySources = [
  "linkedin",
  "indeed",
  "glassdoor",
  "ziprecruiter",
  "google",
  "greenhouse",
  "lever",
  "ashby",
  "wellfound",
  "company",
  "manual",
  "other",
] as const;

const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const url = new URL(v);
      return ["http:", "https:"].includes(url.protocol) && !!url.hostname;
    } catch {
      return false;
    }
  }, "Use a valid http or https URL");
const isoDateTime = z.string().datetime({ offset: true });

export const provenanceSchema = z.object({
  provider: z.enum(discoverySources),
  site: z.string().min(1).max(100),
  url: httpUrl,
  applyUrl: httpUrl.optional(),
  externalId: z.string().min(1).max(200).optional(),
  adapter: z.string().min(1).max(50),
  upstreamVersion: z.string().max(100).optional(),
  runId: z.string().min(1).max(100).optional(),
  discoveredAt: isoDateTime,
});
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * The CanonicalJob contract from ApplyPilot's `@applypilot/job-schema`,
 * restated here so Rolecraft does not depend on that repository. ApplyPilot's
 * discovery-to-Rolecraft integration test keeps the two in step.
 */
export const ingestJobSchema = z.object({
  id: z.string().regex(/^job_[0-9a-f]{16}$/),
  externalId: z.string().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(200),
  location: z.string().max(300).optional(),
  remoteType: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  description: z.string().max(200_000).optional(),
  source: z.enum(discoverySources),
  sourceUrl: httpUrl,
  postedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  salaryMin: z.number().nonnegative().finite().optional(),
  salaryMax: z.number().nonnegative().finite().optional(),
  salaryCurrency: z.string().min(1).max(10).optional(),
  salaryInterval: z
    .enum(["yearly", "monthly", "weekly", "daily", "hourly"])
    .optional(),
  employmentType: z.string().max(200).optional(),
  discoveredAt: isoDateTime,
  provenance: z.array(provenanceSchema).min(1).max(50),
  rawSource: z.unknown().optional(),
  /** Identity keys from ApplyPilot's dedup engine, e.g. "ats:greenhouse:123". */
  dedupKeys: z
    .array(
      z
        .string()
        .regex(/^[a-z]+:.+/)
        .max(600),
    )
    .max(60)
    .optional(),
});
export type IngestJob = z.infer<typeof ingestJobSchema>;

export const ingestRunSchema = z.object({
  runId: z.string().min(1).max(100),
  adapter: z.string().min(1).max(50),
  status: z.enum(["ok", "partial", "failed"]),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  metrics: z.record(z.unknown()),
});
export type IngestRun = z.infer<typeof ingestRunSchema>;

export const MAX_IMPORT_JOBS = 200;
export const ingestPayloadSchema = z.object({
  run: ingestRunSchema,
  jobs: z.array(ingestJobSchema).max(MAX_IMPORT_JOBS),
});

export const statusUpdateSchema = z.object({
  status: z.enum(discoveryStatuses),
  promotedJobId: z.string().min(1).max(100).optional(),
});

/** One inbox row as the API returns it (no description or raw record). */
export type DiscoveredJobSummary = {
  id: string;
  status: DiscoveryStatus;
  title: string;
  company: string;
  location: string | null;
  remoteType: IngestJob["remoteType"];
  source: IngestJob["source"];
  sourceUrl: string;
  postedAt: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryInterval: string | null;
  employmentType: string | null;
  sites: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  promotedJobId: string | null;
};

export type DiscoveredJobDetail = DiscoveredJobSummary & {
  description: string | null;
  provenance: Provenance[];
  rawSource: unknown;
};

/**
 * Add new sightings to the existing provenance. A sighting is identified by
 * site + url + run, so re-importing the same run is a no-op while a later run
 * that sees the posting again is recorded.
 */
export function mergeProvenance(
  existing: Provenance[],
  incoming: Provenance[],
): Provenance[] {
  const key = (p: Provenance) =>
    `${p.site}\u0000${p.url}\u0000${p.runId ?? ""}`;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const p of incoming) {
    if (!seen.has(key(p))) {
      seen.add(key(p));
      merged.push(p);
    }
  }
  return merged;
}

export function distinctSites(provenance: Provenance[]): string[] {
  return [...new Set(provenance.map((p) => p.site))];
}

const platformBySource: Partial<Record<IngestJob["source"], Job["platform"]>> =
  {
    linkedin: "LinkedIn",
    indeed: "Indeed",
    ziprecruiter: "ZipRecruiter",
    wellfound: "Wellfound",
  };
const workModeByRemote: Record<IngestJob["remoteType"], Job["workMode"]> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: "Unknown",
};

function formatSalary(job: DiscoveredJobSummary): string {
  if (job.salaryMin == null && job.salaryMax == null) return "";
  const fmt = (n: number | null) =>
    n == null ? "?" : Math.round(n).toLocaleString("en-US");
  const range =
    job.salaryMin != null &&
    job.salaryMax != null &&
    job.salaryMin !== job.salaryMax
      ? `${fmt(job.salaryMin)}–${fmt(job.salaryMax)}`
      : fmt(job.salaryMin ?? job.salaryMax);
  return [
    range,
    job.salaryCurrency,
    job.salaryInterval && `/${job.salaryInterval}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function salaryLabel(job: DiscoveredJobSummary): string {
  return formatSalary(job);
}

/**
 * Turn a discovered job into a workspace opportunity. Only facts the posting
 * stated are copied; sponsorship, authorization and level stay "unknown"
 * because the discovery sources don't state them reliably.
 */
export function toWorkspaceJob(
  discovered: DiscoveredJobDetail,
  as: "saved" | "applied",
  date: string,
): Job {
  const sites = distinctSites(discovered.provenance).join(", ");
  const salary = formatSalary(discovered);
  const notes = [
    `Discovered via ${sites} on ${discovered.firstSeenAt.slice(0, 10)}.`,
    discovered.postedAt ? `Posted ${discovered.postedAt}.` : "",
    salary ? `Listed pay: ${salary}.` : "",
    discovered.employmentType ? `Type: ${discovered.employmentType}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...newJob(),
    company: discovered.company.slice(0, 150),
    title: discovered.title.slice(0, 200),
    location: (discovered.location ?? "").slice(0, 150),
    workMode: workModeByRemote[discovered.remoteType],
    platform: platformBySource[discovered.source] ?? "Other",
    url: discovered.sourceUrl,
    status: as === "applied" ? "Applied" : "Saved",
    appliedAt: as === "applied" ? date : "",
    description: (discovered.description ?? "").slice(0, 50000),
    notes: notes.slice(0, 20000),
    discoveredJobId: discovered.id,
  };
}

/**
 * Key kinds, strongest first (ApplyPilot's dedup engine defines them). When an
 * import shares keys with several existing jobs, the one matched by the
 * strongest kind wins.
 */
export const KEY_PRIORITY = ["id", "url", "ats", "req", "fp", "cctl"] as const;

export function keyRank(key: string): number {
  const rank = (KEY_PRIORITY as readonly string[]).indexOf(
    key.slice(0, key.indexOf(":")),
  );
  return rank === -1 ? KEY_PRIORITY.length : rank;
}

/** ATS job ids and requisition ids name exactly one opening. */
function conflictScope(key: string): string | null {
  if (key.startsWith("ats:")) return key.slice(0, key.indexOf(":", 4) + 1);
  if (key.startsWith("req:")) return key.slice(0, key.lastIndexOf(":") + 1);
  return null;
}

/** True when the two jobs' keys name different openings, so they must not merge. */
export function keysConflict(
  a: Iterable<string>,
  b: Iterable<string>,
): boolean {
  const scoped = new Map<string, Set<string>>();
  for (const key of a) {
    const scope = conflictScope(key);
    if (scope) {
      if (!scoped.has(scope)) scoped.set(scope, new Set());
      scoped.get(scope)!.add(key);
    }
  }
  for (const key of b) {
    const scope = conflictScope(key);
    const mine = scope ? scoped.get(scope) : undefined;
    if (mine && !mine.has(key)) return true;
  }
  return false;
}

/** Fields an existing discovered job may be missing that a duplicate can supply. */
export type FillableFields = {
  location: string | null;
  postedAt: string | null;
  employmentType: string | null;
  description: string | null;
  remoteType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryInterval: string | null;
};

/**
 * Fill only what the existing job lacks; never overwrite what it has. Salary
 * moves as one unit so a range never mixes two sources.
 */
export function fillMissing(
  existing: FillableFields,
  incoming: Partial<FillableFields>,
): Partial<FillableFields> {
  const patch: Partial<FillableFields> = {};
  for (const field of [
    "location",
    "postedAt",
    "employmentType",
    "description",
  ] as const) {
    if (existing[field] == null && incoming[field] != null)
      patch[field] = incoming[field];
  }
  if (
    existing.remoteType === "unknown" &&
    incoming.remoteType &&
    incoming.remoteType !== "unknown"
  ) {
    patch.remoteType = incoming.remoteType;
  }
  if (
    existing.salaryMin == null &&
    existing.salaryMax == null &&
    (incoming.salaryMin != null || incoming.salaryMax != null)
  ) {
    patch.salaryMin = incoming.salaryMin ?? null;
    patch.salaryMax = incoming.salaryMax ?? null;
    patch.salaryCurrency = incoming.salaryCurrency ?? null;
    patch.salaryInterval = incoming.salaryInterval ?? null;
  }
  return patch;
}

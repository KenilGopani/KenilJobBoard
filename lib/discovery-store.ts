import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { discoveredJobs, discoveryRuns } from "@/db/schema";
import {
  distinctSites,
  mergeProvenance,
  type DiscoveredJobDetail,
  type DiscoveredJobSummary,
  type DiscoveryStatus,
  type IngestJob,
  type IngestRun,
  type Provenance,
} from "./discovery.ts";

type Db = ReturnType<typeof getDb>;
type Row = typeof discoveredJobs.$inferSelect;

function omit<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([k]) => !keys.includes(k as K)),
  ) as Omit<T, K>;
}

// D1 allows at most 100 bound parameters per statement.
const ID_CHUNK = 90;

function parseProvenance(text: string): Provenance[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function summary(
  row: Omit<Row, "description" | "rawSource">,
): DiscoveredJobSummary {
  return {
    id: row.id,
    status: row.status as DiscoveryStatus,
    title: row.title,
    company: row.company,
    location: row.location,
    remoteType: row.remoteType as DiscoveredJobSummary["remoteType"],
    source: row.source as DiscoveredJobSummary["source"],
    sourceUrl: row.sourceUrl,
    postedAt: row.postedAt,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    salaryInterval: row.salaryInterval,
    employmentType: row.employmentType,
    sites: distinctSites(parseProvenance(row.provenance)),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    promotedJobId: row.promotedJobId,
  };
}

function detail(row: Row): DiscoveredJobDetail {
  let rawSource: unknown = null;
  try {
    rawSource = row.rawSource ? JSON.parse(row.rawSource) : null;
  } catch {
    rawSource = null;
  }
  return {
    ...summary(row),
    description: row.description,
    provenance: parseProvenance(row.provenance),
    rawSource,
  };
}

export async function importDiscovery(
  db: Db,
  userId: string,
  run: IngestRun,
  jobs: IngestJob[],
  now = new Date().toISOString(),
) {
  const existing = new Map<string, Provenance[]>();
  const ids = jobs.map((j) => j.id);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: discoveredJobs.id, provenance: discoveredJobs.provenance })
      .from(discoveredJobs)
      .where(
        and(
          eq(discoveredJobs.userId, userId),
          inArray(discoveredJobs.id, ids.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows)
      existing.set(row.id, parseProvenance(row.provenance));
  }

  const statements = jobs.map((job) => {
    const provenance = JSON.stringify(
      mergeProvenance(existing.get(job.id) ?? [], job.provenance),
    );
    const content = {
      title: job.title,
      company: job.company,
      location: job.location ?? null,
      remoteType: job.remoteType,
      source: job.source,
      sourceUrl: job.sourceUrl,
      postedAt: job.postedAt ?? null,
      salaryMin: job.salaryMin ?? null,
      salaryMax: job.salaryMax ?? null,
      salaryCurrency: job.salaryCurrency ?? null,
      salaryInterval: job.salaryInterval ?? null,
      employmentType: job.employmentType ?? null,
      description: job.description ?? null,
      provenance,
      rawSource:
        job.rawSource === undefined ? null : JSON.stringify(job.rawSource),
      lastSeenAt: now,
      lastRunId: run.runId,
    };
    // Status, promotion and first-seen date belong to the user's history and
    // are never overwritten by a later import.
    return db
      .insert(discoveredJobs)
      .values({
        userId,
        id: job.id,
        status: "new",
        firstSeenAt: now,
        ...content,
      })
      .onConflictDoUpdate({
        target: [discoveredJobs.userId, discoveredJobs.id],
        set: content,
      });
  });
  const created = jobs.filter((j) => !existing.has(j.id)).length;
  // Jobs this run has not reported before. Re-sending a run (a retry, or
  // `npm run push` of a saved run) then leaves its counts unchanged.
  const firstSightings = jobs.filter(
    (j) => !(existing.get(j.id) ?? []).some((p) => p.runId === run.runId),
  ).length;

  const runStatement = db
    .insert(discoveryRuns)
    .values({
      userId,
      runId: run.runId,
      adapter: run.adapter,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      metrics: JSON.stringify(run.metrics),
      jobsReceived: firstSightings,
      jobsNew: created,
      importedAt: now,
    })
    .onConflictDoUpdate({
      // A large run arrives in several requests; accumulate its counts.
      target: [discoveryRuns.userId, discoveryRuns.runId],
      set: {
        status: run.status,
        finishedAt: run.finishedAt,
        metrics: JSON.stringify(run.metrics),
        jobsReceived: sql`${discoveryRuns.jobsReceived} + ${firstSightings}`,
        jobsNew: sql`${discoveryRuns.jobsNew} + ${created}`,
        importedAt: now,
      },
    });

  await db.batch([runStatement, ...statements]);
  return { received: jobs.length, created, updated: jobs.length - created };
}

export async function listDiscovered(
  db: Db,
  userId: string,
  status: DiscoveryStatus | null,
  limit = 500,
) {
  // Everything except description and rawSource, which only the detail view needs.
  const columns = omit(getTableColumns(discoveredJobs), [
    "description",
    "rawSource",
  ]);
  const where = status
    ? and(eq(discoveredJobs.userId, userId), eq(discoveredJobs.status, status))
    : eq(discoveredJobs.userId, userId);
  const [rows, counts, runs] = await Promise.all([
    limit === 0
      ? Promise.resolve([])
      : db
          .select(columns)
          .from(discoveredJobs)
          .where(where)
          .orderBy(
            desc(discoveredJobs.lastSeenAt),
            desc(discoveredJobs.postedAt),
          )
          .limit(limit),
    db
      .select({ status: discoveredJobs.status, count: sql<number>`count(*)` })
      .from(discoveredJobs)
      .where(eq(discoveredJobs.userId, userId))
      .groupBy(discoveredJobs.status),
    db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.userId, userId))
      .orderBy(desc(discoveryRuns.importedAt))
      .limit(5),
  ]);
  return {
    jobs: rows.map(summary),
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.count)])),
    runs: runs.map((r) => ({
      runId: r.runId,
      adapter: r.adapter,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      jobsReceived: r.jobsReceived,
      jobsNew: r.jobsNew,
      importedAt: r.importedAt,
    })),
  };
}

export async function getDiscovered(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(discoveredJobs)
    .where(and(eq(discoveredJobs.userId, userId), eq(discoveredJobs.id, id)));
  return row ? detail(row) : null;
}

export async function updateDiscoveredStatus(
  db: Db,
  userId: string,
  id: string,
  status: DiscoveryStatus,
  promotedJobId: string | undefined,
  now = new Date().toISOString(),
) {
  const rows = await db
    .update(discoveredJobs)
    .set({
      status,
      statusUpdatedAt: now,
      ...(promotedJobId ? { promotedJobId } : {}),
    })
    .where(and(eq(discoveredJobs.userId, userId), eq(discoveredJobs.id, id)))
    .returning({ id: discoveredJobs.id });
  return rows.length > 0;
}

export async function deleteDiscovered(db: Db, userId: string, id: string) {
  const rows = await db
    .delete(discoveredJobs)
    .where(and(eq(discoveredJobs.userId, userId), eq(discoveredJobs.id, id)))
    .returning({ id: discoveredJobs.id });
  return rows.length > 0;
}

export async function deleteRun(db: Db, userId: string, runId: string) {
  const rows = await db
    .delete(discoveryRuns)
    .where(
      and(eq(discoveryRuns.userId, userId), eq(discoveryRuns.runId, runId)),
    )
    .returning({ runId: discoveryRuns.runId });
  return rows.length > 0;
}

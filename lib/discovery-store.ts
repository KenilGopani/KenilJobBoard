import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { discoveredJobKeys, discoveredJobs, discoveryRuns } from "@/db/schema";
import type { BatchItem } from "drizzle-orm/batch";
import {
  distinctSites,
  fillMissing,
  keyRank,
  keysConflict,
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

type ImportRow = Omit<Row, "rawSource">;

async function selectChunked<T>(
  values: string[],
  query: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) {
    out.push(...(await query(values.slice(i, i + ID_CHUNK))));
  }
  return out;
}

/**
 * Import one batch from a discovery run.
 *
 * A job that shares an identity key with a job already stored (the same
 * posting found earlier on another board) is merged into that job: every
 * sighting is added to its provenance and only the fields it lacks are
 * filled. Status, promotion and first-seen date of a stored job are never
 * changed by an import. An earlier copy of the incoming job itself is folded
 * into the match only while it is untouched (status new, not promoted).
 */
export async function importDiscovery(
  db: Db,
  userId: string,
  run: IngestRun,
  jobs: IngestJob[],
  now = new Date().toISOString(),
) {
  const incomingKeys = new Map(
    jobs.map((j) => [
      j.id,
      [...new Set([`id:${j.id}`, ...(j.dedupKeys ?? [])])],
    ]),
  );
  const keyOwner = new Map<string, string>();
  for (const row of await selectChunked(
    [...new Set([...incomingKeys.values()].flat())],
    (chunk) =>
      db
        .select({ key: discoveredJobKeys.key, jobId: discoveredJobKeys.jobId })
        .from(discoveredJobKeys)
        .where(
          and(
            eq(discoveredJobKeys.userId, userId),
            inArray(discoveredJobKeys.key, chunk),
          ),
        ),
  ))
    keyOwner.set(row.key, row.jobId);

  // An "id:<job id>" key names a stored job directly, even one imported
  // before keys existed.
  const idKeyIds = [...incomingKeys.values()]
    .flat()
    .filter((k) => k.startsWith("id:"))
    .map((k) => k.slice(3));
  const relevant = [
    ...new Set([...jobs.map((j) => j.id), ...idKeyIds, ...keyOwner.values()]),
  ];
  const rowById = new Map<string, ImportRow>();
  const columns = omit(getTableColumns(discoveredJobs), ["rawSource"]);
  for (const row of await selectChunked(relevant, (chunk) =>
    db
      .select(columns)
      .from(discoveredJobs)
      .where(
        and(
          eq(discoveredJobs.userId, userId),
          inArray(discoveredJobs.id, chunk),
        ),
      ),
  ))
    rowById.set(row.id, row);
  // A stored job always owns its own id key, whatever an older key row says.
  for (const id of rowById.keys()) keyOwner.set(`id:${id}`, id);
  const keysOf = new Map<string, Set<string>>();
  for (const row of await selectChunked([...rowById.keys()], (chunk) =>
    db
      .select({ key: discoveredJobKeys.key, jobId: discoveredJobKeys.jobId })
      .from(discoveredJobKeys)
      .where(
        and(
          eq(discoveredJobKeys.userId, userId),
          inArray(discoveredJobKeys.jobId, chunk),
        ),
      ),
  )) {
    if (!keysOf.has(row.jobId)) keysOf.set(row.jobId, new Set());
    keysOf.get(row.jobId)!.add(row.key);
  }

  const statements: BatchItem<"sqlite">[] = [];
  let created = 0;
  let updated = 0;
  let merged = 0;
  let firstSightings = 0;
  const sawRun = (provenance: Provenance[]) =>
    provenance.some((p) => p.runId === run.runId);

  const addKeys = (jobId: string, keys: string[]) => {
    if (!keysOf.has(jobId)) keysOf.set(jobId, new Set());
    for (const key of keys) {
      if (!keyOwner.has(key)) keyOwner.set(key, jobId);
      keysOf.get(jobId)!.add(key);
      // A key already owned by another (conflicting) job keeps its owner.
      statements.push(
        db
          .insert(discoveredJobKeys)
          .values({ userId, key, jobId })
          .onConflictDoNothing(),
      );
    }
  };

  for (const job of jobs) {
    const keys = incomingKeys.get(job.id)!;
    const own = rowById.get(job.id);
    const ranked = new Map<string, number>();
    for (const key of keys) {
      const owner = keyOwner.get(key);
      if (owner && owner !== job.id && rowById.has(owner)) {
        ranked.set(
          owner,
          Math.min(ranked.get(owner) ?? Infinity, keyRank(key)),
        );
      }
    }
    const target = [...ranked]
      .sort(
        (a, b) =>
          a[1] - b[1] ||
          rowById
            .get(a[0])!
            .firstSeenAt.localeCompare(rowById.get(b[0])!.firstSeenAt),
      )
      .map(([id]) => id)
      .find((id) => !keysConflict(keys, keysOf.get(id) ?? []));
    // A job the user has acted on (status or promotion) always survives a
    // merge; two acted-on jobs are never merged.
    const decided = (row: ImportRow) =>
      row.status !== "new" || row.promotedJobId != null;
    let survivorId = target;
    let victim = own;
    if (target && own) {
      const targetRow = rowById.get(target)!;
      if (decided(own) && decided(targetRow)) survivorId = undefined;
      else if (decided(own)) {
        survivorId = own.id;
        victim = targetRow;
      }
    }

    if (survivorId) {
      const into = rowById.get(survivorId)!;
      let provenance = parseProvenance(into.provenance);
      const victimProvenance = victim ? parseProvenance(victim.provenance) : [];
      if (!sawRun([...provenance, ...victimProvenance])) firstSightings += 1;
      const known = new Set(
        [...provenance, ...victimProvenance].map(
          (p) => `${p.site}\u0000${p.url}\u0000${p.runId ?? ""}`,
        ),
      );
      // Re-sending a sighting the survivor already holds is an update, not a new merge.
      const addsSighting = job.provenance.some(
        (p) => !known.has(`${p.site}\u0000${p.url}\u0000${p.runId ?? ""}`),
      );
      provenance = mergeProvenance(
        mergeProvenance(provenance, victimProvenance),
        job.provenance,
      );
      const fromVictim = victim ? fillMissing(into, victim) : {};
      const patch = {
        ...fromVictim,
        ...fillMissing(
          { ...into, ...fromVictim },
          {
            location: job.location ?? null,
            postedAt: job.postedAt ?? null,
            employmentType: job.employmentType ?? null,
            description: job.description ?? null,
            remoteType: job.remoteType,
            salaryMin: job.salaryMin ?? null,
            salaryMax: job.salaryMax ?? null,
            salaryCurrency: job.salaryCurrency ?? null,
            salaryInterval: job.salaryInterval ?? null,
          },
        ),
      };
      if (victim) {
        statements.push(
          db
            .delete(discoveredJobs)
            .where(
              and(
                eq(discoveredJobs.userId, userId),
                eq(discoveredJobs.id, victim.id),
              ),
            ),
          db
            .update(discoveredJobKeys)
            .set({ jobId: survivorId })
            .where(
              and(
                eq(discoveredJobKeys.userId, userId),
                eq(discoveredJobKeys.jobId, victim.id),
              ),
            ),
        );
        if (!keysOf.has(survivorId)) keysOf.set(survivorId, new Set());
        for (const key of [
          ...(keysOf.get(victim.id) ?? []),
          `id:${victim.id}`,
        ]) {
          keyOwner.set(key, survivorId);
          keysOf.get(survivorId)!.add(key);
        }
        keysOf.delete(victim.id);
        rowById.delete(victim.id);
        // Keep the folded id findable, so a later import of it lands here.
        addKeys(survivorId, [`id:${victim.id}`]);
      }
      const set = {
        ...patch,
        provenance: JSON.stringify(provenance),
        lastSeenAt: now,
        lastRunId: run.runId,
      };
      statements.push(
        db
          .update(discoveredJobs)
          .set(set)
          .where(
            and(
              eq(discoveredJobs.userId, userId),
              eq(discoveredJobs.id, survivorId),
            ),
          ),
      );
      rowById.set(survivorId, { ...into, ...set });
      addKeys(survivorId, keys);
      if (victim || addsSighting) merged += 1;
      else updated += 1;
      continue;
    }

    const before = own ? parseProvenance(own.provenance) : [];
    if (!sawRun(before)) firstSightings += 1;
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
      provenance: JSON.stringify(mergeProvenance(before, job.provenance)),
      rawSource:
        job.rawSource === undefined ? null : JSON.stringify(job.rawSource),
      lastSeenAt: now,
      lastRunId: run.runId,
    };
    // Status, promotion and first-seen date belong to the user's history and
    // are never overwritten by a later import.
    statements.push(
      db
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
        }),
    );
    const { rawSource: _raw, ...stored } = content;
    void _raw;
    rowById.set(job.id, {
      ...(own ?? {
        userId,
        id: job.id,
        status: "new",
        firstSeenAt: now,
        promotedJobId: null,
        statusUpdatedAt: null,
      }),
      ...stored,
    });
    if (own) updated += 1;
    else created += 1;
    addKeys(job.id, keys);
  }

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
      // Re-sending a run (a retry, or importing a saved run again) adds only
      // first sightings, so its counts do not grow.
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

  await db.batch([runStatement, ...statements] as [
    BatchItem<"sqlite">,
    ...BatchItem<"sqlite">[],
  ]);
  return { received: jobs.length, created, updated, merged };
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
  const [, rows] = await db.batch([
    db
      .delete(discoveredJobKeys)
      .where(
        and(
          eq(discoveredJobKeys.userId, userId),
          eq(discoveredJobKeys.jobId, id),
        ),
      ),
    db
      .delete(discoveredJobs)
      .where(and(eq(discoveredJobs.userId, userId), eq(discoveredJobs.id, id)))
      .returning({ id: discoveredJobs.id }),
  ]);
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

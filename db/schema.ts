import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
export const workspaces = sqliteTable("workspaces", {
  userId: text("user_id").primaryKey(),
  data: text("data").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Jobs found by automated discovery (ApplyPilot). Kept apart from the
 * workspace document so a large inbox never slows down or caps the
 * application tracker. `status` is the inbox decision; it is never reset by a
 * later import.
 */
export const discoveredJobs = sqliteTable(
  "discovered_jobs",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    status: text("status").notNull().default("new"),
    title: text("title").notNull(),
    company: text("company").notNull(),
    location: text("location"),
    remoteType: text("remote_type").notNull(),
    source: text("source").notNull(),
    sourceUrl: text("source_url").notNull(),
    postedAt: text("posted_at"),
    salaryMin: real("salary_min"),
    salaryMax: real("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryInterval: text("salary_interval"),
    employmentType: text("employment_type"),
    description: text("description"),
    /** JSON array of every sighting (site, url, run); merged, never replaced. */
    provenance: text("provenance").notNull(),
    /** JSON of the latest untouched upstream record. */
    rawSource: text("raw_source"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastRunId: text("last_run_id"),
    promotedJobId: text("promoted_job_id"),
    statusUpdatedAt: text("status_updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("discovered_jobs_user_status_seen").on(
      t.userId,
      t.status,
      t.lastSeenAt,
    ),
  ],
);

/** One import from a discovery run, with the run's own metrics. */
export const discoveryRuns = sqliteTable(
  "discovery_runs",
  {
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    adapter: text("adapter").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    metrics: text("metrics").notNull(),
    jobsReceived: integer("jobs_received").notNull().default(0),
    jobsNew: integer("jobs_new").notNull().default(0),
    importedAt: text("imported_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.runId] })],
);

/**
 * Identity keys of discovered jobs ("kind:value", computed by ApplyPilot's
 * dedup engine). One key belongs to one job; an import that shares a key with
 * an existing job is merged into it instead of creating a duplicate.
 */
export const discoveredJobKeys = sqliteTable(
  "discovered_job_keys",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    jobId: text("job_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    index("discovered_job_keys_user_job").on(t.userId, t.jobId),
  ],
);

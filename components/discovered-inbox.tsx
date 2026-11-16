"use client";
import { useEffect, useState } from "react";
import {
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  LoaderCircle,
  Radar,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  salaryLabel,
  toWorkspaceJob,
  type DiscoveredJobDetail,
  type DiscoveredJobSummary,
  type DiscoveryStatus,
} from "@/lib/discovery";
import { today, type Job } from "@/lib/workspace";

type Run = {
  runId: string;
  adapter: string;
  status: string;
  jobsReceived: number;
  jobsNew: number;
  importedAt: string;
};
type ListResponse = {
  jobs: DiscoveredJobSummary[];
  counts: Partial<Record<DiscoveryStatus, number>>;
  /** New jobs the hard filters rejected. */
  filtered?: number;
  runs: Run[];
  error?: string;
};

/** Inbox tabs: the five statuses, plus new jobs the hard filters rejected. */
type TabKey = DiscoveryStatus | "filtered";
const tabs: { key: TabKey; label: string }[] = [
  { key: "new", label: "New" },
  { key: "review", label: "Review" },
  { key: "saved", label: "Saved" },
  { key: "applied", label: "Applied" },
  { key: "skip", label: "Skipped" },
  { key: "filtered", label: "Filtered out" },
];

function tabQuery(key: TabKey): string {
  if (key === "new") return "status=new&screening=kept";
  if (key === "filtered") return "status=new&screening=rejected";
  return `status=${key}`;
}

function tabCount(data: ListResponse | null, key: TabKey): number {
  if (!data) return 0;
  const filtered = data.filtered ?? 0;
  if (key === "filtered") return filtered;
  if (key === "new") return Math.max(0, (data.counts.new ?? 0) - filtered);
  return data.counts[key] ?? 0;
}

const authorizationBadge: Record<string, { label: string; tone: string }> = {
  compatible: { label: "Sponsors", tone: "ok" },
  incompatible: { label: "No sponsorship", tone: "bad" },
  "manual-review": { label: "Check work authorization", tone: "warn" },
  unknown: { label: "Sponsorship unknown", tone: "muted" },
};

const decisionLabel: Record<string, string> = {
  apply: "Apply",
  review: "Consider",
  skip: "Skip",
};

const checkTone: Record<string, string> = {
  compatible: "ok",
  incompatible: "bad",
  "manual-review": "warn",
  unknown: "muted",
};

const remoteLabel: Record<DiscoveredJobSummary["remoteType"], string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: "Work mode unknown",
};

function age(date: string | null) {
  if (!date) return "Posting date unknown";
  const days = Math.round(
    (Date.parse(today() + "T12:00:00") - Date.parse(date + "T12:00:00")) /
      86_400_000,
  );
  return days <= 0
    ? "Posted today"
    : days === 1
      ? "Posted yesterday"
      : `Posted ${days}d ago`;
}

export default function DiscoveredInbox({
  demo,
  promotedIds,
  onPromote,
  onNewCount,
}: {
  demo: boolean;
  /** discoveredJobIds already present in the workspace. */
  promotedIds: Set<string>;
  /** Adds the job to the workspace; resolves false if the save failed. */
  onPromote: (job: Job, message: string) => Promise<boolean>;
  onNewCount: (count: number) => void;
}) {
  const [status, setStatus] = useState<TabKey>("new");
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "match">("recent");
  const [open, setOpen] = useState("");
  const [detail, setDetail] = useState<DiscoveredJobDetail | null>(null);
  const [busy, setBusy] = useState("");

  // Bumping this re-runs the list effect (after an action or a refresh).
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    fetch(`/api/discovered-jobs?${tabQuery(status)}`)
      .then(async (r) => {
        const b = (await r.json()) as ListResponse;
        if (!r.ok) throw new Error(b.error);
        return b;
      })
      .then((b) => {
        if (cancelled) return;
        setData(b);
        setError("");
        onNewCount(tabCount(b, "new"));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          e instanceof Error && e.message
            ? e.message
            : "Unable to load discovered jobs.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, status, reloadKey, onNewCount]);

  async function fetchDetail(id: string) {
    const r = await fetch(`/api/discovered-jobs/${encodeURIComponent(id)}`);
    const b = (await r.json()) as { job: DiscoveredJobDetail; error?: string };
    if (!r.ok) throw new Error(b.error);
    return b.job;
  }

  async function toggle(id: string) {
    if (open === id) {
      setOpen("");
      setDetail(null);
      return;
    }
    setOpen(id);
    setDetail(null);
    try {
      setDetail(await fetchDetail(id));
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Unable to open this job.",
      );
    }
  }

  async function setJobStatus(
    id: string,
    next: DiscoveryStatus,
    promotedJobId?: string,
  ) {
    const r = await fetch(`/api/discovered-jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next, promotedJobId }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error || "Could not update this job.");
    }
  }

  async function act(id: string, next: DiscoveryStatus) {
    setBusy(id);
    setError("");
    try {
      if (next === "saved" || next === "applied") {
        // Never create a second opportunity for the same discovered job.
        let promotedJobId: string | undefined;
        if (!promotedIds.has(id)) {
          const job = toWorkspaceJob(
            detail?.id === id ? detail : await fetchDetail(id),
            next,
            today(),
          );
          const ok = await onPromote(
            job,
            next === "applied"
              ? "Added to Opportunities as Applied"
              : "Saved to Opportunities",
          );
          if (!ok) return;
          promotedJobId = job.id;
        }
        await setJobStatus(id, next, promotedJobId);
      } else {
        await setJobStatus(id, next);
      }
      if (open === id) {
        setOpen("");
        setDetail(null);
      }
      reload();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Could not update this job.",
      );
    } finally {
      setBusy("");
    }
  }

  if (demo) {
    return (
      <section className="panel">
        <div className="empty-state">
          <Radar size={28} />
          <h3>Discovered jobs stay out of the demo</h3>
          <p>Leave the demo to review jobs found by your own discovery runs.</p>
        </div>
      </section>
    );
  }

  const q = query.trim().toLowerCase();
  const matching = (data?.jobs ?? []).filter(
    (j) =>
      !q ||
      [j.title, j.company, j.location ?? "", j.sites.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
  );
  // Best match: full evaluations first, then triage, then unevaluated; higher score first.
  const rank = (j: DiscoveredJobSummary) =>
    j.evaluationStage === "full" ? 2 : j.evaluationStage === "triage" ? 1 : 0;
  const jobs =
    sort === "match"
      ? [...matching].sort(
          (a, b) =>
            rank(b) - rank(a) ||
            (b.evaluationScore ?? 0) - (a.evaluationScore ?? 0),
        )
      : matching;
  const lastRun = data?.runs[0];

  return (
    <section className="panel discovery-panel">
      <div className="panel-heading">
        <div>
          <h2>
            Discovered jobs{" "}
            <span className="count-pill">{tabCount(data, status)}</span>
          </h2>
          <p>
            {lastRun
              ? `Last run ${new Date(lastRun.importedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${lastRun.jobsReceived} found, ${lastRun.jobsNew} new${lastRun.status !== "ok" ? ` · ${lastRun.status}` : ""}`
              : "Jobs found by automated search land here before they become applications."}
          </p>
        </div>
        <button
          className="button secondary"
          onClick={reload}
          aria-label="Refresh discovered jobs"
        >
          <RotateCcw size={14} /> Refresh
        </button>
      </div>
      <div className="detail-tabs discovery-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            className={status === t.key ? "selected" : ""}
            onClick={() => {
              setStatus(t.key);
              setLoading(true);
              setOpen("");
              setDetail(null);
            }}
          >
            {t.label} <small>{tabCount(data, t.key)}</small>
          </button>
        ))}
      </div>
      <div className="table-tools">
        <select
          aria-label="Sort discovered jobs"
          className="discovery-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as "recent" | "match")}
        >
          <option value="recent">Newest</option>
          <option value="match">Best match</option>
        </select>
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="Search discovered jobs"
            placeholder="Search titles, companies, locations or sources…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="icon-btn"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {loading && !data ? (
        <div className="empty-state">
          <LoaderCircle className="spin" size={24} />
          <p>Loading discovered jobs…</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="empty-state">
          <Radar size={28} />
          <h3>
            {q
              ? "No matches"
              : status === "new"
                ? "Nothing new yet"
                : status === "filtered"
                  ? "Nothing filtered out"
                  : "Nothing here"}
          </h3>
          <p>
            {q
              ? "Try a different search."
              : status === "new"
                ? 'Run a discovery search from ApplyPilot and push the results here, for example: npm run discover -- "applied ai engineer" --push'
                : status === "filtered"
                  ? "Jobs that fail your hard filters (location, level, required years, sponsorship, salary) wait here with the reason."
                  : "Jobs you move to this list will appear here."}
          </p>
        </div>
      ) : (
        <ul className="discovery-list">
          {jobs.map((j) => {
            const salary = salaryLabel(j);
            const expanded = open === j.id;
            return (
              <li key={j.id} className={expanded ? "expanded" : ""}>
                <div className="discovery-row">
                  <button
                    className="role-cell"
                    aria-expanded={expanded}
                    onClick={() => void toggle(j.id)}
                  >
                    {expanded ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                    <div>
                      <strong>{j.title}</strong>
                      <span>
                        {j.company}
                        <i>·</i>
                        {j.location || "Location not listed"}
                        <i>·</i>
                        {remoteLabel[j.remoteType]}
                      </span>
                      <span className="discovery-badges">
                        {j.evaluationStage === "full" &&
                          j.evaluationScore != null && (
                            <em
                              className={`tone-${j.evaluationDecision === "apply" ? "ok" : j.evaluationDecision === "skip" ? "bad" : "warn"}`}
                            >
                              {j.evaluationScore.toFixed(1)}/5 ·{" "}
                              {decisionLabel[j.evaluationDecision ?? ""] ??
                                j.evaluationDecision}
                            </em>
                          )}
                        {j.evaluationStage === "triage" &&
                          j.evaluationScore != null && (
                            <em
                              className={`tone-${j.evaluationDecision === "PASS" ? "ok" : j.evaluationDecision === "MARGINAL" ? "warn" : "muted"}`}
                            >
                              Quick check {j.evaluationScore.toFixed(1)} ·{" "}
                              {j.evaluationDecision?.toLowerCase()}
                            </em>
                          )}
                        {j.screeningVerdict === "review" && (
                          <em className="tone-warn">Needs review</em>
                        )}
                        {j.screeningVerdict === "reject" && (
                          <em className="tone-bad">Filtered out</em>
                        )}
                        {j.authorization && (
                          <em
                            className={`tone-${authorizationBadge[j.authorization]?.tone ?? "muted"}`}
                          >
                            {authorizationBadge[j.authorization]?.label}
                          </em>
                        )}
                      </span>
                    </div>
                  </button>
                  <div className="discovery-meta">
                    <span>{age(j.postedAt)}</span>
                    {salary && <span>{salary}</span>}
                    <span className="source-cell">{j.sites.join(" + ")}</span>
                  </div>
                  <div className="discovery-actions">
                    {busy === j.id ? (
                      <LoaderCircle
                        className="spin"
                        size={16}
                        aria-label="Updating"
                      />
                    ) : (
                      <>
                        {j.status === "new" && (
                          <button
                            className="button secondary"
                            onClick={() => void act(j.id, "review")}
                          >
                            <Eye size={14} /> Review
                          </button>
                        )}
                        {j.status !== "saved" && j.status !== "applied" && (
                          <button
                            className="button secondary"
                            onClick={() => void act(j.id, "saved")}
                          >
                            <Bookmark size={14} /> Save
                          </button>
                        )}
                        {j.status !== "applied" && (
                          <button
                            className="button secondary"
                            onClick={() => void act(j.id, "applied")}
                          >
                            <CheckCircle2 size={14} /> Applied
                          </button>
                        )}
                        {j.status !== "skip" ? (
                          <button
                            className="button secondary"
                            onClick={() => void act(j.id, "skip")}
                          >
                            <X size={14} /> Skip
                          </button>
                        ) : (
                          <button
                            className="button secondary"
                            onClick={() => void act(j.id, "new")}
                          >
                            <RotateCcw size={14} /> Restore
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {expanded && (
                  <div className="discovery-detail">
                    {!detail ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <>
                        <div className="discovery-links">
                          {detail.provenance.map((p) => (
                            <a
                              key={`${p.site}-${p.url}-${p.runId ?? ""}`}
                              href={p.applyUrl ?? p.url}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {p.site}
                              {p.applyUrl ? " (employer site)" : ""}
                              <ExternalLink size={12} />
                            </a>
                          ))}
                          {detail.employmentType && (
                            <span>{detail.employmentType}</span>
                          )}
                          <span>
                            First seen {detail.firstSeenAt.slice(0, 10)}
                          </span>
                        </div>
                        {detail.evaluation?.stage === "full" && (
                          <div className="discovery-evaluation">
                            <h4>
                              Career Ops evaluation:{" "}
                              {detail.evaluation.evaluation.score.toFixed(1)}/5
                              ·{" "}
                              {decisionLabel[
                                detail.evaluation.evaluation.decision
                              ] ?? detail.evaluation.evaluation.decision}
                            </h4>
                            <p>{detail.evaluation.evaluation.explanation}</p>
                            {detail.evaluation.evaluation.matched.length >
                              0 && (
                              <>
                                <h5>Matches, with your CV&apos;s own words</h5>
                                <ul>
                                  {detail.evaluation.evaluation.matched.map(
                                    (m) => (
                                      <li key={m.requirement.id}>
                                        <strong>{m.requirement.text}</strong>
                                        {m.evidence.map((e, i) => (
                                          <q key={i}>{e.excerpt}</q>
                                        ))}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </>
                            )}
                            {detail.evaluation.evaluation.missing.length >
                              0 && (
                              <>
                                <h5>Gaps</h5>
                                <ul>
                                  {detail.evaluation.evaluation.missing.map(
                                    (m) => (
                                      <li key={m.id}>
                                        <strong>{m.text}</strong>
                                        {m.category === "unverified-match" && (
                                          <em className="tone-warn">
                                            claimed, but not found in your CV
                                          </em>
                                        )}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </>
                            )}
                          </div>
                        )}
                        {detail.evaluation?.stage === "triage" && (
                          <div className="discovery-evaluation">
                            <h4>
                              Quick check: {detail.evaluation.score.toFixed(1)}
                              /5 · {detail.evaluation.verdict.toLowerCase()}
                            </h4>
                            <p>{detail.evaluation.reason}</p>
                          </div>
                        )}
                        {detail.screening && (
                          <ul className="discovery-checks">
                            {detail.screening.checks.map((c, i) => (
                              <li key={`${c.rule}-${i}`}>
                                <em
                                  className={`tone-${checkTone[c.status] ?? "muted"}`}
                                >
                                  {c.status.replace("-", " ")}
                                </em>
                                <span>{c.reason}</span>
                                {c.evidence && <q>{c.evidence}</q>}
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="discovery-description">
                          {detail.description ||
                            "This source did not include a description."}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

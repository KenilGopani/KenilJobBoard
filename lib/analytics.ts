import type { Job } from "./workspace.ts";

/**
 * Application funnel analytics (plan Phase 20). Pure: computed from the
 * workspace's opportunities plus what the Discovered inbox knows about the
 * ones that came from it (sources, evaluation score, resume used).
 */

export interface DiscoveredFacts {
  sites: string[];
  evaluationScore: number | null;
  resumeFamily: string | null;
}

export interface Rates {
  applied: number;
  responded: number;
  screened: number;
  interviewed: number;
  offers: number;
  responseRate: number | null;
  screenRate: number | null;
  interviewRate: number | null;
  offerRate: number | null;
}

export interface Analytics {
  overall: Rates;
  byTrack: Record<string, Rates>;
  bySource: Record<string, Rates>;
  byChannel: Record<string, Rates>;
  byResume: Record<string, Rates>;
  byScore: Record<string, Rates>;
  medianDaysToResponse: number | null;
  insights: string[];
}

const ORDER = ["Saved", "Applied", "Screening", "Interview", "Offer"] as const;
const rank = (s: string) => (ORDER as readonly string[]).indexOf(s);
const ATS =
  /greenhouse|lever|ashby|workday|bamboo|smartrecruiters|workable|company|career/i;

/** The furthest stage an opportunity reached, from its current status and timeline. */
export function furthestStage(job: Job): string {
  let best = rank(job.status);
  for (const a of job.activity ?? [])
    if (a.to) best = Math.max(best, rank(a.to));
  if ((job.interviews?.length ?? 0) > 0)
    best = Math.max(best, rank("Interview"));
  return best >= 0 ? ORDER[best]! : job.status;
}

function wasApplied(job: Job): boolean {
  return Boolean(job.appliedAt) || rank(furthestStage(job)) >= rank("Applied");
}

function rates(jobs: Job[]): Rates {
  const applied = jobs.filter(wasApplied);
  const reached = (stage: string) =>
    applied.filter((j) => rank(furthestStage(j)) >= rank(stage)).length;
  const responded = applied.filter(
    (j) =>
      rank(furthestStage(j)) >= rank("Screening") || j.status === "Rejected",
  ).length;
  const pct = (n: number) =>
    applied.length ? Math.round((n / applied.length) * 1000) / 10 : null;
  const screened = reached("Screening");
  const interviewed = reached("Interview");
  const offers = reached("Offer");
  return {
    applied: applied.length,
    responded,
    screened,
    interviewed,
    offers,
    responseRate: pct(responded),
    screenRate: pct(screened),
    interviewRate: pct(interviewed),
    offerRate: pct(offers),
  };
}

function groupBy(jobs: Job[], key: (j: Job) => string): Record<string, Rates> {
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = key(j);
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  return Object.fromEntries(
    [...groups]
      .map(([k, js]) => [k, rates(js)] as const)
      .filter(([, r]) => r.applied > 0),
  );
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000,
  );
}

export function computeAnalytics(
  jobs: Job[],
  discovered: Map<string, DiscoveredFacts> = new Map(),
): Analytics {
  const facts = (j: Job) =>
    j.discoveredJobId ? discovered.get(j.discoveredJobId) : undefined;
  const scoreBand = (j: Job) => {
    const s = facts(j)?.evaluationScore;
    if (s == null) return "not evaluated";
    return s >= 4 ? "4.0+" : s >= 3 ? "3.0–3.9" : "below 3.0";
  };
  const channel = (j: Job) => {
    const sites = facts(j)?.sites ?? [];
    if (sites.some((s) => ATS.test(s))) return "employer site / ATS";
    if (sites.length) return "job board";
    return /linkedin|indeed|ziprecruiter|jobright/i.test(j.platform)
      ? "job board"
      : "other / manual";
  };
  const responseDays: number[] = [];
  for (const j of jobs) {
    if (!j.appliedAt) continue;
    const first = (j.activity ?? []).find(
      (a) =>
        a.type === "status" &&
        a.from === "Applied" &&
        a.to &&
        a.to !== "Withdrawn",
    );
    if (first)
      responseDays.push(Math.max(0, daysBetween(j.appliedAt, first.at)));
  }
  responseDays.sort((a, b) => a - b);
  const median = responseDays.length
    ? responseDays[Math.floor((responseDays.length - 1) / 2)]!
    : null;

  const result: Analytics = {
    overall: rates(jobs),
    byTrack: groupBy(jobs, (j) => j.track),
    bySource: groupBy(jobs, (j) => facts(j)?.sites.join(" + ") || j.platform),
    byChannel: groupBy(jobs, channel),
    byResume: groupBy(jobs, (j) => facts(j)?.resumeFamily ?? "unknown"),
    byScore: groupBy(jobs, scoreBand),
    medianDaysToResponse: median,
    insights: [],
  };
  result.insights = insights(result);
  return result;
}

/** Plain-language answers to the plan's questions, only where the data supports them. */
function insights(a: Analytics): string[] {
  const out: string[] = [];
  const MIN = 5;
  const best = (groups: Record<string, Rates>, label: string) => {
    const ranked = Object.entries(groups)
      .filter(([, r]) => r.applied >= MIN && r.responseRate !== null)
      .sort((x, y) => y[1].responseRate! - x[1].responseRate!);
    if (ranked.length >= 2) {
      out.push(
        `${label}: "${ranked[0]![0]}" gets the most responses (${ranked[0]![1].responseRate}% of ${ranked[0]![1].applied}).`,
      );
    }
  };
  best(a.byTrack, "Role family");
  best(a.byResume, "Resume");
  best(a.byChannel, "Channel");
  const hi = a.byScore["4.0+"];
  const lo = a.byScore["below 3.0"] ?? a.byScore["3.0–3.9"];
  if (hi && lo && hi.applied >= MIN && lo.applied >= MIN) {
    out.push(
      hi.interviewRate! > lo.interviewRate!
        ? `High-scoring matches convert better (${hi.interviewRate}% vs ${lo.interviewRate}% reach interviews).`
        : `High scores are not converting better yet (${hi.interviewRate}% vs ${lo.interviewRate}% reach interviews); review the scoring targets.`,
    );
  }
  if (a.overall.applied < MIN)
    out.push(
      `Only ${a.overall.applied} applications so far; rates become meaningful after about ${MIN * 4}.`,
    );
  return out;
}

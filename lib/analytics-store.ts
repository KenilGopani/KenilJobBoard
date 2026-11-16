import { and, eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { discoveredJobs, workspaces } from "@/db/schema";
import { computeAnalytics, type DiscoveredFacts } from "./analytics.ts";
import { workspaceSchema } from "./workspace.ts";

type Db = ReturnType<typeof getDb>;

/** Analytics for one user: workspace opportunities joined with their discovered records. */
export async function loadAnalytics(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.userId, userId));
  const parsed = row ? workspaceSchema.safeParse(JSON.parse(row.data)) : null;
  const jobs = parsed?.success ? parsed.data.jobs : [];
  const linked = jobs
    .map((j) => j.discoveredJobId)
    .filter((id): id is string => Boolean(id));
  const facts = new Map<string, DiscoveredFacts>();
  for (const id of linked) {
    const [d] = await db
      .select({
        provenance: discoveredJobs.provenance,
        evaluationScore: discoveredJobs.evaluationScore,
        evaluationStage: discoveredJobs.evaluationStage,
        preparation: discoveredJobs.preparation,
      })
      .from(discoveredJobs)
      .where(and(eq(discoveredJobs.userId, userId), eq(discoveredJobs.id, id)));
    if (!d) continue;
    let sites: string[] = [];
    let resumeFamily: string | null = null;
    try {
      sites = [
        ...new Set(
          (JSON.parse(d.provenance) as { site: string }[]).map((p) => p.site),
        ),
      ];
    } catch {
      sites = [];
    }
    try {
      resumeFamily = d.preparation
        ? (JSON.parse(d.preparation).resume?.family ?? null)
        : null;
    } catch {
      resumeFamily = null;
    }
    facts.set(id, {
      sites,
      evaluationScore: d.evaluationStage === "full" ? d.evaluationScore : null,
      resumeFamily,
    });
  }
  return computeAnalytics(jobs, facts);
}

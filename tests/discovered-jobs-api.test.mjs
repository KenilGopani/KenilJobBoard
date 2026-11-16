import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Runs against the local dev server and database (see README). Uses the local
// mock identity and deletes every job it creates.
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const headers = {
  "Content-Type": "application/json",
  Cookie: "__sites_local_auth=1",
  Origin: base,
};
const api = (path, init = {}) =>
  fetch(`${base}/api/discovered-jobs${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });

const at = "2026-11-15T12:00:00.000Z";
function job(n, runId) {
  const id = `job_${randomBytes(8).toString("hex")}`;
  const url = `https://www.indeed.com/viewjob?jk=qa${id.slice(4)}`;
  return {
    id,
    externalId: `in-qa${n}`,
    title: `QA Fixture Engineer ${n}`,
    company: "Fictional Test Co",
    location: "Austin, TX, USA",
    remoteType: "remote",
    description: "Fictional posting used by the API test.",
    source: "indeed",
    sourceUrl: url,
    postedAt: "2026-11-14",
    salaryMin: 100000,
    salaryMax: 120000,
    salaryCurrency: "USD",
    salaryInterval: "yearly",
    discoveredAt: at,
    provenance: [
      {
        provider: "indeed",
        site: "indeed",
        url,
        adapter: "jobspy",
        runId,
        discoveredAt: at,
      },
    ],
    rawSource: { id: `in-qa${n}`, site: "indeed", marker: "raw-kept" },
  };
}
const run = (runId) => ({
  runId,
  adapter: "jobspy",
  status: "ok",
  startedAt: at,
  finishedAt: at,
  metrics: { returned: 2 },
});

test("discovered jobs API imports idempotently, keeps provenance and decisions, and enforces auth", async () => {
  const runA = `run_qa_${randomBytes(4).toString("hex")}`;
  const runB = `${runA}_b`;
  const jobs = [job(1, runA), job(2, runA)];
  const post = (body, extra) =>
    api("", { method: "POST", body: JSON.stringify(body), headers: extra });

  assert.equal((await fetch(`${base}/api/discovered-jobs`)).status, 401);
  assert.equal(
    (
      await post(
        { run: run(runA), jobs },
        { Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  const invalid = await post({
    run: run(runA),
    jobs: [{ ...jobs[0], sourceUrl: "javascript:alert(1)" }],
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (await post({ run: run(runA), jobs: [jobs[0], jobs[0]] })).status,
    400,
  );

  try {
    const first = await post({ run: run(runA), jobs });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      received: 2,
      created: 2,
      updated: 0,
      merged: 0,
    });

    // Re-importing the same run changes nothing visible.
    const again = await (await post({ run: run(runA), jobs })).json();
    assert.deepEqual(again, { received: 2, created: 0, updated: 2, merged: 0 });

    // A human decision survives later imports.
    const patch = await api(`/${jobs[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "skip" }),
    });
    assert.equal(patch.status, 200);

    // A later run that sees the posting again on another board adds provenance.
    const linkedin = {
      provider: "linkedin",
      site: "linkedin",
      url: "https://www.linkedin.com/jobs/view/999000111",
      adapter: "jobspy",
      runId: runB,
      discoveredAt: at,
    };
    const second = {
      ...jobs[0],
      title: "QA Fixture Engineer 1 (updated)",
      provenance: [{ ...jobs[0].provenance[0], runId: runB }, linkedin],
    };
    await post({ run: run(runB), jobs: [second] });

    const detail = await (await api(`/${jobs[0].id}`)).json();
    assert.equal(detail.job.status, "skip");
    assert.equal(detail.job.title, "QA Fixture Engineer 1 (updated)");
    assert.equal(detail.job.provenance.length, 3);
    assert.deepEqual(detail.job.sites, ["indeed", "linkedin"]);
    assert.equal(detail.job.rawSource.marker, "raw-kept");
    assert.equal(detail.job.salaryInterval, "yearly");

    const skipped = await (await api("?status=skip")).json();
    assert.ok(skipped.jobs.some((j) => j.id === jobs[0].id));
    assert.ok(!skipped.jobs.some((j) => j.id === jobs[1].id));
    assert.equal(
      skipped.jobs[0].description,
      undefined,
      "list omits descriptions",
    );
    assert.ok(
      skipped.runs.some((r) => r.runId === runA && r.jobsReceived === 2),
    );

    const promoted = await api(`/${jobs[1].id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "saved",
        promotedJobId: "workspace-job-1",
      }),
    });
    assert.equal(promoted.status, 200);
    const saved = await (await api(`/${jobs[1].id}`)).json();
    assert.equal(saved.job.promotedJobId, "workspace-job-1");

    assert.equal((await api("?status=bogus")).status, 400);
    assert.equal(
      (
        await api(`/${jobs[1].id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "Applied" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api("/job_0000000000000000", {
          method: "PATCH",
          body: JSON.stringify({ status: "skip" }),
        })
      ).status,
      404,
    );
  } finally {
    for (const r of [runA, runB]) await api(`/runs/${r}`, { method: "DELETE" });
    for (const j of jobs) {
      const res = await api(`/${j.id}`, { method: "DELETE" });
      assert.ok([200, 404].includes(res.status));
    }
  }
  assert.equal((await api(`/${jobs[0].id}`)).status, 404);
  const runs = (await (await api("?limit=0")).json()).runs;
  assert.ok(!runs.some((r) => r.runId.startsWith(runA)), "test runs removed");
  assert.equal((await api(`/runs/${runA}`, { method: "DELETE" })).status, 404);
});

test("imports merge the same posting across sources, respect conflicting ids, and never fold a decided job", async () => {
  const runId = `run_qa_dedup_${randomBytes(4).toString("hex")}`;
  const tag = randomBytes(3).toString("hex");
  const post = (jobs) =>
    api("", {
      method: "POST",
      body: JSON.stringify({ run: run(runId), jobs }),
    }).then((r) => r.json());
  const withKeys = (j, keys, extra = {}) => ({
    ...j,
    dedupKeys: keys,
    ...extra,
  });
  const created = [];
  const track = (...js) => created.push(...js.map((j) => j.id));
  const get = async (id) => (await api(`/${id}`)).json();

  const ats = `ats:greenhouse:${tag}111`;
  const cctl = `cctl:fictional test co|qa ${tag}|austin`;
  try {
    // 1. The employer's posting, stored first without a description.
    const atsJob = withKeys(job(1, runId), [cctl, ats], {
      description: undefined,
      source: "greenhouse",
    });
    track(atsJob);
    assert.deepEqual(await post([atsJob]), {
      received: 1,
      created: 1,
      updated: 0,
      merged: 0,
    });

    // 2. A board copy whose apply link is that posting merges into it and fills the description.
    const board = withKeys(job(2, runId), [ats], {
      description: "Board description",
    });
    track(board);
    assert.deepEqual(await post([board]), {
      received: 1,
      created: 0,
      updated: 0,
      merged: 1,
    });
    assert.equal((await api(`/${board.id}`)).status, 404, "no second row");
    const stored = (await get(atsJob.id)).job;
    assert.equal(stored.description, "Board description");
    assert.equal(stored.provenance.length, 2);
    assert.equal(
      stored.source,
      "greenhouse",
      "the stored job keeps its identity",
    );

    // 3. Same company/title/city but a different ATS id is a different opening.
    const other = withKeys(job(3, runId), [cctl, `ats:greenhouse:${tag}222`]);
    track(other);
    assert.deepEqual(await post([other]), {
      received: 1,
      created: 1,
      updated: 0,
      merged: 0,
    });

    // 4. An earlier, untouched copy stored without keys is folded into the match.
    const legacy = job(4, runId);
    const match = withKeys(job(5, runId), [`cctl:fold ${tag}`]);
    track(legacy, match);
    await post([legacy]);
    await post([match]);
    assert.deepEqual(await post([withKeys(legacy, [`cctl:fold ${tag}`])]), {
      received: 1,
      created: 0,
      updated: 0,
      merged: 1,
    });
    assert.equal((await api(`/${legacy.id}`)).status, 404);
    const folded = (await get(match.id)).job;
    assert.ok(folded.provenance.some((p) => p.url === legacy.sourceUrl));

    // 5. A copy the user already acted on survives: the untouched twin folds into it.
    const decided = job(6, runId);
    const twin = withKeys(job(7, runId), [`cctl:keep ${tag}`]);
    track(decided, twin);
    await post([decided]);
    await api(`/${decided.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "skip" }),
    });
    await post([twin]);
    assert.deepEqual(await post([withKeys(decided, [`cctl:keep ${tag}`])]), {
      received: 1,
      created: 0,
      updated: 0,
      merged: 1,
    });
    const kept = (await get(decided.id)).job;
    assert.equal(kept.status, "skip");
    assert.ok(kept.provenance.some((p) => p.url === twin.sourceUrl));
    assert.equal((await api(`/${twin.id}`)).status, 404);

    // 6. Two copies stored before keys existed are joined by id keys alone.
    const oldA = job(8, runId);
    const oldB = job(9, runId);
    track(oldA, oldB);
    await post([oldA, oldB]);
    assert.equal((await post([withKeys(oldA, [`id:${oldB.id}`])])).merged, 1);
    const statuses = await Promise.all(
      [oldA, oldB].map(async (j) => (await api(`/${j.id}`)).status),
    );
    assert.deepEqual(statuses.sort(), [200, 404], "exactly one row remains");

    // 7. Two jobs the user acted on are never merged.
    const r1 = job(10, runId);
    const r2 = job(11, runId);
    track(r1, r2);
    await post([r1, r2]);
    for (const j of [r1, r2])
      await api(`/${j.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "review" }),
      });
    assert.equal((await post([withKeys(r1, [`id:${r2.id}`])])).merged, 0);
    assert.equal((await api(`/${r2.id}`)).status, 200);
  } finally {
    for (const id of created) await api(`/${id}`, { method: "DELETE" });
    await api(`/runs/${runId}`, { method: "DELETE" });
  }
});

test("screened jobs are stored with their checks, and rejected ones leave the inbox for Filtered out", async () => {
  const runId = `run_qa_screen_${randomBytes(4).toString("hex")}`;
  const screening = (verdict, authorization) => ({
    verdict,
    authorization,
    checks: [
      {
        rule: "work-authorization",
        status: authorization,
        reason: "From the posting",
        ...(authorization === "incompatible"
          ? { evidence: "We are not able to sponsor visas." }
          : {}),
      },
    ],
    screenedAt: at,
    policyVersion: "filters@1",
  });
  const kept = { ...job(1, runId), screening: screening("pass", "unknown") };
  const rejected = {
    ...job(2, runId),
    screening: screening("reject", "incompatible"),
  };
  const unscreened = job(3, runId);
  try {
    const res = await api("", {
      method: "POST",
      body: JSON.stringify({
        run: run(runId),
        jobs: [kept, rejected, unscreened],
      }),
    });
    assert.equal(res.status, 200);
    const inbox = await (await api("?status=new&screening=kept")).json();
    const ids = inbox.jobs.map((j) => j.id);
    assert.ok(
      ids.includes(kept.id) && ids.includes(unscreened.id),
      "unscreened jobs stay in the inbox",
    );
    assert.ok(!ids.includes(rejected.id));
    const filtered = await (await api("?status=new&screening=rejected")).json();
    assert.deepEqual(
      filtered.jobs
        .map((j) => j.id)
        .filter((id) => [kept.id, rejected.id, unscreened.id].includes(id)),
      [rejected.id],
    );
    assert.ok(filtered.filtered >= 1);
    const row = filtered.jobs.find((j) => j.id === rejected.id);
    assert.equal(row.screeningVerdict, "reject");
    assert.equal(row.authorization, "incompatible");
    const detail = (await (await api(`/${rejected.id}`)).json()).job;
    assert.equal(
      detail.screening.checks[0].evidence,
      "We are not able to sponsor visas.",
    );
    // A later import without screening keeps the stored one.
    await api("", {
      method: "POST",
      body: JSON.stringify({
        run: run(runId),
        jobs: [{ ...rejected, screening: undefined }],
      }),
    });
    assert.equal(
      (await (await api(`/${rejected.id}`)).json()).job.screeningVerdict,
      "reject",
    );
    assert.equal((await api("?screening=bogus")).status, 400);
  } finally {
    for (const j of [kept, rejected, unscreened])
      await api(`/${j.id}`, { method: "DELETE" });
    await api(`/runs/${runId}`, { method: "DELETE" });
  }
});

test("evaluations are stored on a job, shown in the list, and a quick check never overwrites a full evaluation", async () => {
  const runId = `run_qa_eval_${randomBytes(4).toString("hex")}`;
  const j = job(1, runId);
  const put = (body) =>
    api(`/${j.id}/evaluation`, { method: "PUT", body: JSON.stringify(body) });
  const triage = {
    stage: "triage",
    evaluator: "career-ops triage",
    evaluatedAt: at,
    verdict: "PASS",
    score: 4.1,
    reason: "fits",
  };
  const full = {
    stage: "full",
    evaluation: {
      evaluator: "career-ops",
      evaluatedAt: at,
      score: 4.4,
      scoreScale: { min: 1, max: 5 },
      decision: "apply",
      confidence: 0.6,
      matched: [
        {
          requirement: {
            id: "r1",
            text: "Python APIs",
            importance: "critical",
          },
          evidence: [{ document: "cv.md", excerpt: "Built FastAPI services" }],
        },
      ],
      missing: [],
      workAuthorization: "unknown",
      explanation: "Apply. Strong overlap.",
    },
  };
  try {
    await api("", {
      method: "POST",
      body: JSON.stringify({ run: run(runId), jobs: [j] }),
    });
    assert.equal((await put(triage)).status, 200);
    let row = (await (await api(`/${j.id}`)).json()).job;
    assert.deepEqual(
      [row.evaluationStage, row.evaluationScore, row.evaluationDecision],
      ["triage", 4.1, "PASS"],
    );
    assert.equal((await (await put(full)).json()).result, "stored");
    assert.equal((await (await put(triage)).json()).result, "kept-full");
    row = (await (await api(`/${j.id}`)).json()).job;
    assert.deepEqual(
      [row.evaluationStage, row.evaluationScore, row.evaluationDecision],
      ["full", 4.4, "apply"],
    );
    assert.equal(
      row.evaluation.evaluation.matched[0].evidence[0].excerpt,
      "Built FastAPI services",
    );
    const listed = (await (await api("?status=new")).json()).jobs.find(
      (x) => x.id === j.id,
    );
    assert.equal(listed.evaluationScore, 4.4);
    assert.equal((await put({ ...triage, score: 9 })).status, 400);
    assert.equal(
      (
        await api(`/job_0000000000000000/evaluation`, {
          method: "PUT",
          body: JSON.stringify(triage),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await api(`/${j.id}/evaluation`, {
          method: "PUT",
          body: JSON.stringify(triage),
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
  } finally {
    await api(`/${j.id}`, { method: "DELETE" });
    await api(`/runs/${runId}`, { method: "DELETE" });
  }
});

test("an application prep bundle is stored and shown; nothing else changes", async () => {
  const runId = `run_qa_prep_${randomBytes(4).toString("hex")}`;
  const j = job(1, runId);
  const bundle = {
    preparedAt: at,
    resume: {
      family: "applied-ai",
      reason: "AI focus",
      versionId: "rv_0123456789ab",
      file: "/tmp/rv.md",
      changedLines: 3,
      matchedTerms: ["Python"],
    },
    priorities: [
      {
        action: "reorder-skills",
        detail: "List Python first",
        evidence: "Python",
      },
    ],
    gaps: ["PyTorch"],
    drafts: {
      coverLetter: "Dear [Hiring Manager], …",
      outreach: "Hi!",
      whyCompany: "RAG",
      unverifiedNumbers: [],
    },
    checklist: ["Submit the application yourself on the employer's site"],
  };
  try {
    await api("", {
      method: "POST",
      body: JSON.stringify({ run: run(runId), jobs: [j] }),
    });
    const put = (b) =>
      api(`/${j.id}/preparation`, { method: "PUT", body: JSON.stringify(b) });
    assert.equal((await put(bundle)).status, 200);
    const stored = (await (await api(`/${j.id}`)).json()).job;
    assert.equal(stored.preparation.resume.versionId, "rv_0123456789ab");
    assert.equal(stored.preparedAt, at);
    assert.equal(
      stored.status,
      "new",
      "preparing never changes the inbox status",
    );
    assert.equal(
      (await put({ ...bundle, resume: { ...bundle.resume, family: "other" } }))
        .status,
      400,
    );
    assert.equal(
      (
        await api(`/job_0000000000000000/preparation`, {
          method: "PUT",
          body: JSON.stringify(bundle),
        })
      ).status,
      404,
    );
  } finally {
    await api(`/${j.id}`, { method: "DELETE" });
    await api(`/runs/${runId}`, { method: "DELETE" });
  }
});

test("analytics are private and computed from the workspace", async () => {
  assert.equal((await fetch(`${base}/api/analytics`)).status, 401);
  const res = await fetch(`${base}/api/analytics`, { headers });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(typeof a.overall.applied, "number");
  assert.ok(Array.isArray(a.insights));
});

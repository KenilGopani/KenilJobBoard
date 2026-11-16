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
    });

    // Re-importing the same run changes nothing visible.
    const again = await (await post({ run: run(runA), jobs })).json();
    assert.deepEqual(again, { received: 2, created: 0, updated: 2 });

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
      skipped.runs.some((r) => r.runId === runA && r.jobsReceived === 4),
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

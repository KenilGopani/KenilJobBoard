import test from "node:test";
import assert from "node:assert/strict";
import { computeAnalytics, furthestStage } from "../lib/analytics.ts";
import { newJob } from "../lib/workspace.ts";

const at = (d) => `${d}T12:00:00.000Z`;
function app(over = {}) {
  return {
    ...newJob(),
    company: "Co",
    title: "Engineer",
    status: "Applied",
    appliedAt: "2026-10-01",
    ...over,
  };
}

test("the furthest stage counts past progress even after a rejection", () => {
  const j = app({
    status: "Rejected",
    activity: [
      {
        at: at("2026-10-05"),
        type: "status",
        from: "Applied",
        to: "Interview",
      },
      {
        at: at("2026-10-20"),
        type: "status",
        from: "Interview",
        to: "Rejected",
      },
    ],
  });
  assert.equal(furthestStage(j), "Interview");
});

test("funnel rates, groups and time to response", () => {
  const discovered = new Map([
    [
      "d1",
      {
        sites: ["greenhouse-api"],
        evaluationScore: 4.4,
        resumeFamily: "applied-ai",
      },
    ],
    [
      "d2",
      { sites: ["linkedin"], evaluationScore: 2.5, resumeFamily: "core-swe" },
    ],
  ]);
  const jobs = [
    app({
      track: "Applied AI Engineer",
      discoveredJobId: "d1",
      status: "Interview",
      activity: [
        {
          at: at("2026-10-04"),
          type: "status",
          from: "Applied",
          to: "Screening",
        },
      ],
    }),
    app({
      track: "Applied AI Engineer",
      status: "Rejected",
      activity: [
        {
          at: at("2026-10-11"),
          type: "status",
          from: "Applied",
          to: "Rejected",
        },
      ],
    }),
    app({ track: "Backend Engineer", discoveredJobId: "d2" }),
    { ...newJob(), company: "Co", title: "Saved only" },
  ];
  const a = computeAnalytics(jobs, discovered);
  assert.equal(
    a.overall.applied,
    3,
    "saved-only opportunities are not applications",
  );
  assert.equal(a.overall.responded, 2, "a rejection is a response");
  assert.equal(a.overall.interviewed, 1);
  assert.equal(a.overall.responseRate, 66.7);
  assert.equal(a.byTrack["Applied AI Engineer"].applied, 2);
  assert.equal(a.byChannel["employer site / ATS"].interviewed, 1);
  assert.equal(a.byChannel["job board"].applied, 2);
  assert.equal(a.byResume["applied-ai"].applied, 1);
  assert.equal(a.byScore["4.0+"].interviewRate, 100);
  assert.equal(a.medianDaysToResponse, 3);
  assert.match(a.insights.join(" "), /Only 3 applications so far/);
});

test("no data gives empty, null rates rather than misleading zeros", () => {
  const a = computeAnalytics([]);
  assert.equal(a.overall.applied, 0);
  assert.equal(a.overall.responseRate, null);
  assert.equal(a.medianDaysToResponse, null);
});

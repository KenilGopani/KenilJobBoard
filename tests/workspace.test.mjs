import test from "node:test";
import assert from "node:assert/strict";
import {
  analyze,
  calendarEvent,
  emptyWorkspace,
  newJob,
  outreach,
  workspaceSchema,
  jobSchema,
} from "../lib/workspace.ts";
test("resume bytes, LaTeX commands, whitespace and CRLF survive validation and JSON roundtrip", () => {
  const source =
    "\\documentclass{article}\r\n\\section{Experience}\r\n  \\item RAG APIs \\textbf{25\\%}\r\n";
  const state = { ...emptyWorkspace, resume: { name: "resume.tex", source } };
  assert.equal(
    workspaceSchema.parse(JSON.parse(JSON.stringify(state))).resume.source,
    source,
  );
  analyze("RAG, APIs, evaluation", source);
  outreach({ ...newJob(), company: "Example", title: "AI Engineer" }, source);
  assert.equal(state.resume.source, source);
});
test("matching reports gaps and avoids a score without a resume or requirements", () => {
  const a = analyze(
    "RAG, agents, evaluation, guardrails and APIs",
    "Built RAG pipelines and Python APIs.",
  );
  assert.equal(a.score, 40);
  assert.equal(a.gaps.length, 3);
  assert.equal(analyze("RAG", "").score, null);
  assert.equal(analyze("Team collaboration", "Python").score, null);
});
test("outreach never invents project results and only mentions matching focus areas", () => {
  const job = {
    ...newJob(),
    company: "Example",
    title: "AI Engineer",
    description: "RAG and guardrails",
    recruiter: "Alex",
  };
  const draft = outreach(job, "RAG service");
  assert.match(draft, /Hi Alex/);
  assert.match(draft, /verified project result/);
  assert.doesNotMatch(draft, /My resume includes.*Guardrails/);
});
test("calendar exports escape user content and calculate exclusive next-day end across years", () => {
  const job = {
    ...newJob(),
    company: "Example, Inc; AI",
    title: "Engineer",
    followUp: "2026-12-31",
    notes: "First line\nSecond line",
  };
  const ics = calendarEvent(job);
  assert.match(ics, /DTEND;VALUE=DATE:20270101/);
  assert.match(ics, /Example\\, Inc\\; AI/);
  assert.match(ics, /First line\\nSecond line/);
  assert.match(ics, /BEGIN:VALARM/);
});
test("reject unsafe job URLs and impossible calendar dates", () => {
  const base = { ...newJob(), company: "Example", title: "Engineer" };
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/resume",
    "https://",
  ])
    assert.equal(jobSchema.safeParse({ ...base, url }).success, false);
  assert.equal(
    jobSchema.safeParse({ ...base, deadline: "2026-02-30" }).success,
    false,
  );
});

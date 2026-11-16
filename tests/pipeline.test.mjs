import test from "node:test";
import assert from "node:assert/strict";
import {
  jobSchema,
  logInterview,
  newJob,
  withStatusChange,
} from "../lib/workspace.ts";

const at = "2026-11-16T12:00:00.000Z";
const base = () => ({ ...newJob(), company: "Example", title: "Engineer" });

test("a new opportunity records its creation; Saved schedules nothing", () => {
  const job = withStatusChange(undefined, base(), "2026-11-16", at);
  assert.deepEqual(job.activity, [{ at, type: "created", to: "Saved" }]);
  assert.equal(job.followUp, "");
  assert.equal(jobSchema.safeParse(job).success, true);
});

test("Applied dates the application and schedules a follow-up a week later", () => {
  const saved = withStatusChange(undefined, base(), "2026-11-16", at);
  const applied = withStatusChange(
    saved,
    { ...saved, status: "Applied" },
    "2026-11-16",
    at,
  );
  assert.equal(applied.appliedAt, "2026-11-16");
  assert.equal(applied.followUp, "2026-11-23");
  assert.equal(applied.reminderDone, false);
  assert.deepEqual(
    applied.activity.slice(1).map((a) => [a.type, a.from ?? null, a.to]),
    [
      ["status", "Saved", "Applied"],
      ["follow-up-scheduled", null, "2026-11-23"],
    ],
  );
});

test("a future follow-up you set is kept; closed processes stop reminders", () => {
  const job = { ...base(), status: "Applied", followUp: "2026-12-30" };
  const screening = withStatusChange(
    job,
    { ...job, status: "Screening" },
    "2026-11-16",
    at,
  );
  assert.equal(screening.followUp, "2026-12-30");
  const rejected = withStatusChange(
    screening,
    { ...screening, status: "Rejected" },
    "2026-11-20",
    at,
  );
  assert.equal(rejected.followUp, "");
  assert.equal(rejected.reminderDone, true);
});

test("saving without a stage change adds nothing to the timeline", () => {
  const job = withStatusChange(undefined, base(), "2026-11-16", at);
  const edited = withStatusChange(
    job,
    { ...job, notes: "called" },
    "2026-11-17",
    at,
  );
  assert.equal(edited.activity.length, 1);
});

test("logging an interview records the round and moves earlier stages to Interview", () => {
  const applied = { ...base(), status: "Applied", appliedAt: "2026-11-01" };
  const interviewed = logInterview(
    applied,
    { date: "2026-11-18", round: "Recruiter screen", notes: "" },
    at,
  );
  assert.equal(interviewed.status, "Interview");
  assert.equal(interviewed.interviews.length, 1);
  assert.equal(
    interviewed.followUp,
    "2026-11-21",
    "a thank-you / follow-up three days after",
  );
  assert.ok(
    interviewed.activity.some(
      (a) => a.type === "interview" && /Recruiter screen/.test(a.note),
    ),
  );
  const offer = { ...base(), status: "Offer" };
  assert.equal(
    logInterview(offer, { date: "2026-11-18", round: "Final", notes: "" }, at)
      .status,
    "Offer",
  );
});

test("workspaces saved before the timeline existed still validate", () => {
  const legacy = base();
  delete legacy.activity;
  delete legacy.interviews;
  assert.equal(jobSchema.safeParse(legacy).success, true);
});

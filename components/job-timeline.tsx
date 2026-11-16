"use client";
import { useState } from "react";
import { logInterview, today, type Job } from "@/lib/workspace";

const describe: Record<
  string,
  (a: NonNullable<Job["activity"]>[number]) => string
> = {
  created: (a) => `Added as ${a.to}`,
  status: (a) => `${a.from} → ${a.to}`,
  "follow-up-scheduled": (a) =>
    `Follow-up set for ${a.to}${a.note ? ` (${a.note})` : ""}`,
  interview: (a) => `Interview: ${a.note ?? ""}`,
};

/** The opportunity's timeline, plus a small form to log an interview round. */
export default function JobTimeline({
  job,
  disabled,
  onSave,
}: {
  job: Job;
  disabled: boolean;
  onSave: (job: Job) => Promise<boolean>;
}) {
  const [round, setRound] = useState("");
  const [date, setDate] = useState(today());
  const events = [...(job.activity ?? [])].reverse();
  return (
    <div className="job-timeline">
      <h4>Timeline</h4>
      {events.length ? (
        <ul>
          {events.slice(0, 12).map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span>{a.at.slice(0, 10)}</span>
              {describe[a.type]?.(a) ?? a.type}
            </li>
          ))}
        </ul>
      ) : (
        <p>Stage changes, follow-ups and interviews will appear here.</p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!round.trim()) return;
          if (
            await onSave(
              logInterview(job, { date, round: round.trim(), notes: "" }),
            )
          )
            setRound("");
        }}
      >
        <input
          aria-label="Interview round"
          placeholder="Log interview round (e.g. Recruiter screen)"
          value={round}
          onChange={(e) => setRound(e.target.value)}
        />
        <input
          aria-label="Interview date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button
          className="button secondary"
          disabled={disabled || !round.trim()}
        >
          Log
        </button>
      </form>
    </div>
  );
}

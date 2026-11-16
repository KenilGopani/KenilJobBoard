"use client";
import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { computeAnalytics, type Analytics, type Rates } from "@/lib/analytics";
import type { Job } from "@/lib/workspace";

const pct = (n: number | null) => (n === null ? "—" : `${n}%`);

function Table({
  title,
  groups,
}: {
  title: string;
  groups: Record<string, Rates>;
}) {
  const rows = Object.entries(groups).sort(
    (a, b) => b[1].applied - a[1].applied,
  );
  if (!rows.length) return null;
  return (
    <section className="panel analytics-table">
      <div className="panel-heading">
        <h2>{title}</h2>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>GROUP</th>
              <th>APPLIED</th>
              <th>RESPONSE</th>
              <th>SCREEN</th>
              <th>INTERVIEW</th>
              <th>OFFER</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, r]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{r.applied}</td>
                <td>{pct(r.responseRate)}</td>
                <td>{pct(r.screenRate)}</td>
                <td>{pct(r.interviewRate)}</td>
                <td>{pct(r.offerRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Funnel analytics. In the demo it is computed from the fictional roles only. */
export default function AnalyticsPanel({
  demo,
  demoJobs,
}: {
  demo: boolean;
  demoJobs: Job[];
}) {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) return;
    fetch("/api/analytics")
      .then(async (r) => {
        const b = (await r.json()) as Analytics & { error?: string };
        if (!r.ok) throw new Error(b.error);
        setData(b as Analytics);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Unable to load analytics."),
      );
  }, [demo]);
  const a = demo ? computeAnalytics(demoJobs) : data;
  if (error) return <div className="error-banner">{error}</div>;
  if (!a)
    return (
      <div className="empty-state">
        <LoaderCircle className="spin" size={24} />
      </div>
    );
  const o = a.overall;
  return (
    <div className="analytics">
      <section className="panel analytics-summary">
        {(
          [
            ["Applications", String(o.applied)],
            ["Response rate", pct(o.responseRate)],
            ["Recruiter screens", pct(o.screenRate)],
            ["Interviews", pct(o.interviewRate)],
            ["Offers", pct(o.offerRate)],
            [
              "Median days to response",
              a.medianDaysToResponse === null
                ? "—"
                : String(a.medianDaysToResponse),
            ],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>
      {a.insights.length > 0 && (
        <section className="panel analytics-insights">
          <ul>
            {a.insights.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
      )}
      <Table title="By role family" groups={a.byTrack} />
      <Table title="By resume" groups={a.byResume} />
      <Table title="Employer site vs job board" groups={a.byChannel} />
      <Table title="By source" groups={a.bySource} />
      <Table title="By evaluation score" groups={a.byScore} />
    </div>
  );
}

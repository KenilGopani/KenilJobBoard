import { getDb } from "@/db";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  discoveryStatuses,
  ingestPayloadSchema,
  type DiscoveryStatus,
} from "@/lib/discovery";
import { importDiscovery, listDiscovered } from "@/lib/discovery-store";
import {
  readJson,
  rejectCrossOrigin,
  unauthorized,
  unavailable,
  validationError,
} from "@/lib/api-request";

// 200 jobs with full descriptions and raw records.
const MAX_IMPORT_BYTES = 8_000_000;

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  // limit=0 returns only counts and runs (used for the sidebar badge).
  const limit = Number(params.get("limit") ?? 500);
  const screening = params.get("screening");
  if (screening && screening !== "kept" && screening !== "rejected")
    return Response.json(
      { error: "screening must be kept or rejected." },
      { status: 400 },
    );
  if (!Number.isInteger(limit) || limit < 0 || limit > 500)
    return Response.json({ error: "limit must be 0-500." }, { status: 400 });
  if (status && !(discoveryStatuses as readonly string[]).includes(status))
    return Response.json({ error: "Unknown status." }, { status: 400 });
  try {
    const result = await listDiscovered(
      getDb(),
      user.userId,
      (status as DiscoveryStatus | null) ?? null,
      limit,
      screening as "kept" | "rejected" | null,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return unavailable();
  }
}

/** Import one batch of canonical jobs from a discovery run. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request, MAX_IMPORT_BYTES);
  if (!body.ok) return body.response;
  const parsed = ingestPayloadSchema.safeParse(body.value);
  if (!parsed.success) return validationError(parsed.error.issues);
  const ids = parsed.data.jobs.map((j) => j.id);
  if (new Set(ids).size !== ids.length)
    return Response.json(
      { error: "Duplicate job ids in one import." },
      { status: 400 },
    );
  try {
    const result = await importDiscovery(
      getDb(),
      user.userId,
      parsed.data.run,
      parsed.data.jobs,
    );
    return Response.json(result);
  } catch {
    return unavailable();
  }
}

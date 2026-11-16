import { getDb } from "@/db";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { statusUpdateSchema } from "@/lib/discovery";
import {
  deleteDiscovered,
  getDiscovered,
  updateDiscoveredStatus,
} from "@/lib/discovery-store";
import {
  readJson,
  rejectCrossOrigin,
  unauthorized,
  unavailable,
  validationError,
} from "@/lib/api-request";

type Context = { params: Promise<{ id: string }> };
const notFound = () =>
  Response.json({ error: "Discovered job not found." }, { status: 404 });

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const { id } = await params;
  try {
    const job = await getDiscovered(getDb(), user.userId, id);
    return job
      ? Response.json({ job }, { headers: { "Cache-Control": "no-store" } })
      : notFound();
  } catch {
    return unavailable();
  }
}

/** Change the inbox status; optionally record the workspace job it became. */
export async function PATCH(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request, 10_000);
  if (!body.ok) return body.response;
  const parsed = statusUpdateSchema.safeParse(body.value);
  if (!parsed.success) return validationError(parsed.error.issues);
  const { id } = await params;
  try {
    const updated = await updateDiscoveredStatus(
      getDb(),
      user.userId,
      id,
      parsed.data.status,
      parsed.data.promotedJobId,
    );
    return updated ? Response.json({ ok: true }) : notFound();
  } catch {
    return unavailable();
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const { id } = await params;
  try {
    return (await deleteDiscovered(getDb(), user.userId, id))
      ? Response.json({ ok: true })
      : notFound();
  } catch {
    return unavailable();
  }
}

import { getDb } from "@/db";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { deleteRun } from "@/lib/discovery-store";
import {
  rejectCrossOrigin,
  unauthorized,
  unavailable,
} from "@/lib/api-request";

type Context = { params: Promise<{ runId: string }> };

/** Remove a run from the history. Its jobs stay in the inbox. */
export async function DELETE(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const { runId } = await params;
  try {
    return (await deleteRun(getDb(), user.userId, runId))
      ? Response.json({ ok: true })
      : Response.json({ error: "Run not found." }, { status: 404 });
  } catch {
    return unavailable();
  }
}

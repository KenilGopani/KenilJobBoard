import { getDb } from "@/db";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { evaluationPayloadSchema } from "@/lib/discovery";
import { setEvaluation } from "@/lib/discovery-store";
import {
  readJson,
  rejectCrossOrigin,
  unauthorized,
  unavailable,
  validationError,
} from "@/lib/api-request";

type Context = { params: Promise<{ id: string }> };

/** Store a triage result or a full evaluation from ApplyPilot. */
export async function PUT(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request, 200_000);
  if (!body.ok) return body.response;
  const parsed = evaluationPayloadSchema.safeParse(body.value);
  if (!parsed.success) return validationError(parsed.error.issues);
  const { id } = await params;
  try {
    const result = await setEvaluation(getDb(), user.userId, id, parsed.data);
    if (result === "not-found")
      return Response.json(
        { error: "Discovered job not found." },
        { status: 404 },
      );
    return Response.json({ ok: true, result });
  } catch {
    return unavailable();
  }
}

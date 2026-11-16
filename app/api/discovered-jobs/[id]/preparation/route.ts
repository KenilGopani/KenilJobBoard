import { getDb } from "@/db";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { preparationSchema } from "@/lib/discovery";
import { setPreparation } from "@/lib/discovery-store";
import {
  readJson,
  rejectCrossOrigin,
  unauthorized,
  unavailable,
  validationError,
} from "@/lib/api-request";

type Context = { params: Promise<{ id: string }> };

/** Store ApplyPilot's application preparation bundle. Display only: nothing is submitted. */
export async function PUT(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request, 200_000);
  if (!body.ok) return body.response;
  const parsed = preparationSchema.safeParse(body.value);
  if (!parsed.success) return validationError(parsed.error.issues);
  const { id } = await params;
  try {
    return (await setPreparation(getDb(), user.userId, id, parsed.data))
      ? Response.json({ ok: true })
      : Response.json({ error: "Discovered job not found." }, { status: 404 });
  } catch {
    return unavailable();
  }
}

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { workspaces } from "@/db/schema";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { emptyWorkspace, workspaceSchema } from "@/lib/workspace";
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: "Sign in to access your workspace." },
      { status: 401 },
    );
  try {
    const [row] = await getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, user.userId));
    return Response.json(
      {
        workspace: row ? JSON.parse(row.data) : emptyWorkspace,
        revision: row?.revision ?? 0,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Your workspace could not be loaded. Please retry." },
      { status: 503 },
    );
  }
}
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: "Sign in to save your workspace." },
      { status: 401 },
    );
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return Response.json({ error: "Invalid origin." }, { status: 403 });
  let payload;
  try {
    const raw = await request.text();
    if (raw.length > 2000000)
      return Response.json(
        { error: "Workspace is too large." },
        { status: 413 },
      );
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const result = workspaceSchema.safeParse(payload.workspace);
  if (
    !result.success ||
    !Number.isInteger(payload.revision) ||
    payload.revision < 0
  )
    return Response.json({ error: "Invalid workspace data." }, { status: 400 });
  const revision = payload.revision;
  try {
    const db = getDb();
    const values = {
      data: JSON.stringify(result.data),
      revision: revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (revision === 0) {
      const rows = await db
        .insert(workspaces)
        .values({ userId: user.userId, ...values })
        .onConflictDoNothing()
        .returning();
      if (!rows.length)
        return Response.json(
          {
            error:
              "This workspace changed in another tab. Reload before saving.",
          },
          { status: 409 },
        );
    } else {
      const rows = await db
        .update(workspaces)
        .set(values)
        .where(
          and(
            eq(workspaces.userId, user.userId),
            eq(workspaces.revision, revision),
          ),
        )
        .returning();
      if (!rows.length)
        return Response.json(
          {
            error:
              "This workspace changed in another tab. Reload before saving.",
          },
          { status: 409 },
        );
    }
    return Response.json({ revision: revision + 1 });
  } catch {
    return Response.json(
      { error: "Changes could not be saved. Please retry." },
      { status: 503 },
    );
  }
}

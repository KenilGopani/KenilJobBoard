import { getDb } from "@/db";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { loadAnalytics } from "@/lib/analytics-store";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: "Sign in to see analytics." },
      { status: 401 },
    );
  try {
    return Response.json(await loadAnalytics(getDb(), user.userId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Analytics could not be loaded. Please retry." },
      { status: 503 },
    );
  }
}

/** Request guards shared by the discovered-jobs routes. */

export function rejectCrossOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json({ error: "Invalid origin." }, { status: 403 });
  return null;
}

export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const raw = await request.text();
  if (raw.length > maxBytes)
    return {
      ok: false,
      response: Response.json(
        { error: "Request is too large." },
        { status: 413 },
      ),
    };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Invalid JSON." }, { status: 400 }),
    };
  }
}

export function validationError(
  issues: { path: (string | number)[]; message: string }[],
) {
  return Response.json(
    {
      error: "Invalid request.",
      issues: issues
        .slice(0, 20)
        .map((i) => `${i.path.join(".")}: ${i.message}`),
    },
    { status: 400 },
  );
}

export const unauthorized = () =>
  Response.json(
    { error: "Sign in to access discovered jobs." },
    { status: 401 },
  );

export const unavailable = () =>
  Response.json(
    { error: "Discovered jobs could not be reached. Please retry." },
    { status: 503 },
  );

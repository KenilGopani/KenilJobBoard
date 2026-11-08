import test from "node:test";
import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const headers = {
  "Content-Type": "application/json",
  Cookie: "__sites_local_auth=1",
  Origin: base,
};
test("private workspace API validates data, persists losslessly, and rejects stale updates", async () => {
  const anonymous = await fetch(`${base}/api/workspace`);
  assert.equal(anonymous.status, 401);
  const initial = await (
    await fetch(`${base}/api/workspace`, { headers })
  ).json();
  assert.ok(initial.workspace);
  let revision = initial.revision;
  const put = (workspace, rev = revision, extra = {}) =>
    fetch(`${base}/api/workspace`, {
      method: "PUT",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ workspace, revision: rev }),
    });
  const invalid = await put({ ...initial.workspace, weeklyGoal: -1 });
  assert.equal(invalid.status, 400);
  const foreign = await put(initial.workspace, revision, {
    Origin: "https://untrusted.example",
  });
  assert.equal(foreign.status, 403);
  const source =
    "\\documentclass{article}\r\n\\section{Work}\r\n  RAG + Python APIs  \r\n";
  const next = { ...initial.workspace, resume: { name: "qa.tex", source } };
  try {
    const response = await put(next);
    assert.equal(response.status, 200);
    const written = await response.json();
    revision = written.revision;
    const read = await (
      await fetch(`${base}/api/workspace`, { headers })
    ).json();
    assert.equal(read.workspace.resume.source, source);
    const stale = await put(initial.workspace, initial.revision);
    assert.equal(stale.status, 409);
    const again = await (
      await fetch(`${base}/api/workspace`, { headers })
    ).json();
    assert.equal(again.workspace.resume.source, source);
  } finally {
    const restore = await put(initial.workspace, revision);
    assert.equal(restore.status, 200);
  }
});

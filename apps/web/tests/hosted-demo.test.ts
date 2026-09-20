// @vitest-environment node
import { expect, it } from "vitest";
import { hostedDemo } from "../lib/api/hosted-demo";

it("serves seeded evidence and streams an answer without external services", async () => {
  const send = (path: string, body: object, accept = "application/json") =>
    hostedDemo(new Request(`https://demo.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept },
      body: JSON.stringify(body),
    }), path);
  const session = await send("/api/ask/sessions", { caseId: "case:harrisburg-bindery" });
  expect(session.status).toBe(200);
  const { sessionId } = await session.json();
  const answer = await send(`/api/ask/sessions/${sessionId}/messages`, {
    question: "What evidence contradicts sprinkler coverage?",
  }, "text/event-stream");
  expect(answer.headers.get("content-type")).toContain("text/event-stream");
  const text = await answer.text();
  expect(text).toContain("event: answer");
  expect(text).toContain("annex");
  const deleted = await hostedDemo(new Request(`https://demo.test/api/ask/sessions/${sessionId}`, {
    method: "DELETE",
  }), `/api/ask/sessions/${sessionId}`);
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe("");
});

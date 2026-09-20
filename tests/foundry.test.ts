import { expect, it } from "vitest";
import { FoundryPlanner } from "../packages/integrations/src/agent.js";

it("calls the configured Foundry agent Responses endpoint with server credentials", async () => {
  let request: Request | undefined;
  const planner = new FoundryPlanner(
    "https://zettelkasten-resource.services.ai.azure.com/api/projects/zettelkasten/",
    "lloyd-openai",
    "foundry-secret",
    async (input, init) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              name: "plan_step",
              arguments: JSON.stringify({
                tool: "query_federato",
                reason: "Resolve a missing fact.",
                query: "{}",
                documentId: null,
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  await planner.next({ steps: [], allowedQuery: {} } as never);
  expect(request?.url).toBe(
    "https://zettelkasten-resource.services.ai.azure.com/api/projects/zettelkasten/agents/lloyd-openai/endpoint/protocols/openai/responses?api-version=v1",
  );
  expect(request?.headers.get("api-key")).toBe("foundry-secret");
});

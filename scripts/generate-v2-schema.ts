import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { IntakeV2 } from "../packages/contracts/src/intake-v2.js";
writeFileSync("apps/edge-gateway/gateway/intake-v2.schema.json", JSON.stringify(zodToJsonSchema(IntakeV2, "IntakeV2"), null, 2)+"\n");

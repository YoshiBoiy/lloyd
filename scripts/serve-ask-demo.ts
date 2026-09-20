import { createApp } from "../apps/api/src/app.js";
// Deliberately does not load .env, credentials, or any live integration.
const app = createApp();
await app.listen({
  port: Number(process.env.ASK_DEMO_PORT ?? 3101),
  host: "127.0.0.1",
});
console.log(
  "Synthetic Ask Lloyd API ready. Use Load synthetic demo in /explore.",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));

process.argv.splice(2, 0, "evidence");
await import("./rebuild-ask-projection.js");
export {};

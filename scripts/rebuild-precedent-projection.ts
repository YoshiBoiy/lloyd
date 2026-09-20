process.argv.splice(2, 0, "precedents");
await import("./rebuild-ask-projection.js");
export {};

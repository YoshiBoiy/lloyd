import { describe, expect, it } from "vitest";
import { isWorkstationLoopback } from "../lib/local-workstation";

describe("USB workstation loopback gate", () => {
  it("allows only this machine's Next origin, not LAN or forwarded clients", () => {
    expect(isWorkstationLoopback({ host: "127.0.0.1:3000" })).toBe(true);
    expect(isWorkstationLoopback({ host: "localhost:3000" })).toBe(true);
    expect(isWorkstationLoopback({ host: "[::1]:3000" })).toBe(true);
    expect(isWorkstationLoopback({ host: "127.0.0.1:3000", forwardedFor: "::ffff:127.0.0.1" })).toBe(true);
    expect(isWorkstationLoopback({ host: "10.37.108.165:3000" })).toBe(false);
    expect(isWorkstationLoopback({ host: "127.0.0.1:3000", forwardedFor: "8.8.8.8" })).toBe(false);
    expect(isWorkstationLoopback({ host: "127.0.0.1:3000", forwardedFor: "127.0.0.1" })).toBe(true);
  });
});

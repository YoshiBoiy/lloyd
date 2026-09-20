import { afterEach, describe, expect, it } from "vitest";
import {
  LAN_BOARD,
  USB_BOARD,
  ensureUsbGatewayTunnel,
  isWorkstationLoopback,
  resetUsbGatewayTunnel,
} from "../lib/local-workstation";

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

describe("USB gateway tunnel", () => {
  afterEach(() => {
    resetUsbGatewayTunnel();
  });

  it("does not spawn ssh when the local forward is already listening", async () => {
    const hosts: string[] = [];
    await expect(
      ensureUsbGatewayTunnel({
        portOpen: async () => true,
        spawnTunnel: async (host) => {
          hosts.push(host);
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(hosts).toEqual([]);
  });

  it("respawns after a successful tunnel dies, instead of reusing the stale success", async () => {
    let listening = false;
    const hosts: string[] = [];
    const runtime = {
      portOpen: async () => listening,
      spawnTunnel: async (host: string) => {
        hosts.push(host);
        listening = true;
        return true;
      },
    };
    await expect(ensureUsbGatewayTunnel(runtime)).resolves.toBe(true);
    listening = false;
    await expect(ensureUsbGatewayTunnel(runtime)).resolves.toBe(true);
    expect(hosts).toEqual([USB_BOARD, USB_BOARD]);
  });

  it("falls through to the Wi-Fi board address when the USB gadget is absent", async () => {
    const hosts: string[] = [];
    await expect(
      ensureUsbGatewayTunnel({
        portOpen: async () => false,
        spawnTunnel: async (host) => {
          hosts.push(host);
          return host === LAN_BOARD;
        },
      }),
    ).resolves.toBe(true);
    expect(hosts).toEqual([USB_BOARD, LAN_BOARD]);
  });

  it("coalesces concurrent callers into a single spawn", async () => {
    let started = 0;
    let finish!: (ok: boolean) => void;
    const spawn = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const runtime = {
      portOpen: async () => false,
      spawnTunnel: async () => {
        started += 1;
        return spawn;
      },
    };
    const first = ensureUsbGatewayTunnel(runtime);
    await expect.poll(() => started).toBe(1);
    const second = ensureUsbGatewayTunnel(runtime);
    expect(started).toBe(1);
    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(started).toBe(1);
  });
});

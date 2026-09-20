import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const USB_BOARD = "192.168.128.10";
export const LAN_BOARD = "192.168.51.190";
export const TUNNEL_PORT = 18001;

export function boardHosts(): string[] {
  const fromEnv = process.env.EDGE_BOARD_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return fromEnv && fromEnv.length > 0 ? fromEnv : [USB_BOARD, LAN_BOARD];
}

function hostnameOf(hostHeader: string): string {
  const host = hostHeader.split(",")[0]?.trim() ?? "";
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracket) return bracket[1];
  return host.replace(/:\d+$/, "");
}

function isLoopbackAddress(value: string): boolean {
  const ip = value.trim().toLowerCase();
  if (!ip) return false;
  if (ip === "localhost" || ip === "::1" || ip === ":1") return true;
  if (ip.startsWith("::ffff:")) return isLoopbackAddress(ip.slice(7));
  return /^127(?:\.\d+){3}$/.test(ip);
}

/**
 * Auto-pairing is only for the operator's own Next process on loopback.
 * A phone on the LAN, or any forwarded request, must still paste a token.
 */
export function isWorkstationLoopback(input: { host?: string | null; forwardedFor?: string | null }): boolean {
  if (!isLoopbackAddress(hostnameOf(input.host ?? ""))) return false;
  const forwarded = input.forwardedFor?.split(",")[0]?.trim();
  if (!forwarded) return true;
  return isLoopbackAddress(forwarded);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function controlPath(host: string): string {
  return join(homedir(), ".ssh", `lloyd-rdk-tunnel-${host.replace(/[^\w.]+/g, "-")}`);
}

function spawnOnce(host: string, socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        join(homedir(), ".ssh", "lloyd_rdk"),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=3",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${socket}`,
        "-o",
        "ControlPersist=yes",
        "-f",
        "-N",
        "-L",
        `${TUNNEL_PORT}:127.0.0.1:8001`,
        "-R",
        "3001:127.0.0.1:3001",
        `root@${host}`,
      ],
      { stdio: "ignore" },
    );
    child.once("error", () => resolve(false));
    child.once("exit", async (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      for (let i = 0; i < 25; i += 1) {
        if (await portOpen(TUNNEL_PORT)) {
          resolve(true);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      resolve(false);
    });
  });
}

async function spawnSshTunnel(host: string): Promise<boolean> {
  const socket = controlPath(host);
  if (await spawnOnce(host, socket)) return true;
  await unlink(socket).catch(() => undefined);
  return spawnOnce(host, socket);
}

export type GatewayTunnelRuntime = {
  portOpen?: (port: number) => Promise<boolean>;
  spawnTunnel?: (host: string) => Promise<boolean>;
  hosts?: readonly string[];
};

let inFlight: Promise<boolean> | null = null;

export function resetUsbGatewayTunnel(): void {
  inFlight = null;
}

/** Bring up Mac:18001 → board:8001. Retries after the cable is unplugged. */
export function ensureUsbGatewayTunnel(runtime: GatewayTunnelRuntime = {}): Promise<boolean> {
  if (inFlight) return inFlight;
  const open = runtime.portOpen ?? portOpen;
  const spawnTunnel = runtime.spawnTunnel ?? spawnSshTunnel;
  const hosts = runtime.hosts ?? boardHosts();
  inFlight = (async () => {
    try {
      if (await open(TUNNEL_PORT)) return true;
      for (const host of hosts) {
        if (await spawnTunnel(host)) return true;
      }
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

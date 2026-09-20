import { spawn } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const USB_BOARD = "192.168.128.10";
const TUNNEL_PORT = 18001;

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

let tunnelAttempt: Promise<boolean> | null = null;

/** Bring up Mac:18001 → board:8001 when the USB gadget is present. Idempotent. */
export async function ensureUsbGatewayTunnel(): Promise<boolean> {
  if (await portOpen(TUNNEL_PORT)) return true;
  if (!tunnelAttempt) {
    tunnelAttempt = new Promise((resolve) => {
      const child = spawn(
        "ssh",
        [
          "-i",
          join(homedir(), ".ssh", "lloyd_rdk"),
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ControlMaster=auto",
          "-o",
          `ControlPath=${join(homedir(), ".ssh", "lloyd-rdk-tunnel")}`,
          "-o",
          "ControlPersist=yes",
          "-f",
          "-N",
          "-L",
          `${TUNNEL_PORT}:127.0.0.1:8001`,
          "-R",
          "3001:127.0.0.1:3001",
          `root@${USB_BOARD}`,
        ],
        { stdio: "ignore" },
      );
      child.once("error", () => {
        tunnelAttempt = null;
        resolve(false);
      });
      child.once("exit", async (code) => {
        if (code !== 0) {
          tunnelAttempt = null;
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
        tunnelAttempt = null;
        resolve(false);
      });
    });
  }
  return tunnelAttempt;
}

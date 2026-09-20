import { NextRequest, NextResponse } from "next/server";
import { ensureUsbGatewayTunnel, isWorkstationLoopback } from "@/lib/local-workstation";

/**
 * Plug-and-play bootstrap for a USB-attached RDK X5.
 *
 * The pairing token stays server-side (`EDGE_LOCAL_TOKEN`) and is handed to this
 * tab only when the request is from loopback. It is never inlined into the JS bundle.
 */
export async function GET(request: NextRequest) {
  if (
    !isWorkstationLoopback({
      host: request.headers.get("host"),
      forwardedFor: request.headers.get("x-forwarded-for"),
    })
  ) {
    return NextResponse.json({ error: { code: "NOT_LOCAL" } }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  await ensureUsbGatewayTunnel();

  const pairingToken = process.env.EDGE_LOCAL_TOKEN ?? "";
  if (!pairingToken) {
    return NextResponse.json(
      { error: { code: "UNPAIRED", message: "This workstation has no local pairing token configured." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      pairingToken,
      approvalToken: process.env.EDGE_HUMAN_APPROVAL_TOKEN ?? "",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

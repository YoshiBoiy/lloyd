import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { IntakeView } from "../components/intake/IntakeView";
import { CaseWorkspace } from "../components/case/CaseWorkspace";

const CASE_ID = "case:1001";
const ACCOUNT_NAME = "Allegheny Tool & Die";

describe("case-scoped intake entry points", () => {
  it("names the case it will attach to and links back to it", async () => {
    render(<IntakeView caseId={CASE_ID} />);
    const back = await waitFor(() => screen.getByRole("link", { name: ACCOUNT_NAME }));
    expect(back).toHaveAttribute("href", "/cases/case%3A1001");
    expect(screen.getByRole("heading", { name: "Secure intake" })).toBeInTheDocument();
  });

  it("offers a scan shortcut from the case workspace", async () => {
    render(<CaseWorkspace id={CASE_ID} />);
    const scan = await waitFor(() => screen.getByRole("link", { name: /Scan supporting document/i }));
    expect(scan).toHaveAttribute("href", "/cases/case%3A1001/intake");
  });
});

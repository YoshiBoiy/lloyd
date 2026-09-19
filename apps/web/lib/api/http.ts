import type {
  ActivityItem,
  AnalyticsSummary,
  CaseDetail,
  CaseListFilters,
  CaseListResponse,
  CloudDestination,
  GuidelineClause,
  IntakeDocument,
  InvestigationStep,
  LloydApi,
  OutboundPayload,
  SensitiveFieldType,
} from "./types";

/**
 * HTTP adapter for the integration pass.
 * Base URLs are read from NEXT_PUBLIC_LLOYD_API_URL and NEXT_PUBLIC_LLOYD_EDGE_URL.
 * Until those services are wired, the app factory stays on MockLloydApi.
 */
export class HttpLloydApi implements LloydApi {
  constructor(
    private readonly apiBase: string,
    private readonly edgeBase: string,
    private latencyMs = 0,
  ) {}

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  async listCases(filters: CaseListFilters = {}): Promise<CaseListResponse> {
    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.state) params.set("state", filters.state);
    if (filters.decision) params.set("decision", filters.decision);
    if (filters.assignee) params.set("assignee", filters.assignee);
    if (filters.stage) params.set("stage", filters.stage);
    return this.api(`/api/cases?${params.toString()}`);
  }

  getCase(id: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}`);
  }

  async investigate(id: string, onStep?: (step: InvestigationStep) => void): Promise<CaseDetail> {
    const investigation = await this.api<{ id: string }>(`/api/cases/${encodeURIComponent(id)}/investigate`, {
      method: "POST",
    });
    const detail = await this.pollInvestigation(id, investigation.id, onStep);
    return detail;
  }

  applyBrokerResponse(id: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/simulate`, {
      method: "POST",
      body: JSON.stringify({ scenario: "broker_response" }),
    });
  }

  recalculate(id: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/simulate`, {
      method: "POST",
      body: JSON.stringify({ scenario: "recalculate" }),
    });
  }

  draftInformationRequest(id: string): Promise<{ id: string; questions: string[]; rationale: string[] }> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/actions/draft-information-request`, {
      method: "POST",
    });
  }

  recordOverride(id: string, reason: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/override`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  addNote(id: string, body: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  updateAuthenticity(
    id: string,
    reviewState: NonNullable<CaseDetail["authenticity"]>["reviewState"],
  ): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/authenticity`, {
      method: "POST",
      body: JSON.stringify({ reviewState }),
    });
  }

  listGuidelines(query?: string): Promise<GuidelineClause[]> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    return this.api(`/api/guidelines?${params.toString()}`);
  }

  getAnalytics(): Promise<AnalyticsSummary> {
    return this.api("/api/analytics/summary");
  }

  getActivity(): Promise<ActivityItem[]> {
    return this.api("/api/activity");
  }

  getIntake(): Promise<IntakeDocument> {
    return this.edge("/capture/current");
  }

  captureIntake(): Promise<IntakeDocument> {
    return this.edge("/capture", { method: "POST" });
  }

  rescanIntake(): Promise<IntakeDocument> {
    return this.edge("/capture", { method: "POST", body: JSON.stringify({ rescan: true }) });
  }

  advanceIntakeProcessing(): Promise<IntakeDocument> {
    return this.edge("/documents/current/ocr", { method: "POST" });
  }

  toggleRedaction(spanId: string, enabled: boolean): Promise<IntakeDocument> {
    return this.edge(`/documents/current/redact`, {
      method: "POST",
      body: JSON.stringify({ spanId, enabled }),
    });
  }

  addManualRedaction(start: number, end: number, type: SensitiveFieldType): Promise<IntakeDocument> {
    return this.edge(`/documents/current/redact`, {
      method: "POST",
      body: JSON.stringify({ start, end, type }),
    });
  }

  approveAndRelease(input: {
    destinations: CloudDestination[];
    approvedBy: string;
    acceptLowConfidence: boolean;
  }): Promise<{ document: IntakeDocument; payload: OutboundPayload }> {
    return this.edge("/documents/current/release", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async resetDemo(): Promise<void> {
    await this.api("/api/bootstrap", { method: "POST" });
  }

  private async pollInvestigation(
    caseId: string,
    investigationId: string,
    onStep?: (step: InvestigationStep) => void,
  ): Promise<CaseDetail> {
    const investigation = await this.api<{ steps: InvestigationStep[] }>(
      `/api/cases/${encodeURIComponent(caseId)}/investigations/${encodeURIComponent(investigationId)}`,
    );
    investigation.steps.forEach((step) => onStep?.(step));
    return this.getCase(caseId);
  }

  private api<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.apiBase, path, init);
  }

  private edge<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.edgeBase, path, init);
  }

  private async request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${path}`);
    }
    return response.json() as Promise<T>;
  }
}

"use client";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight, MessageSquarePlus, Trash2 } from "lucide-react";
import {
  AnswerCards,
  SearchCards,
  SourceCard,
  StatusTag,
  PrecedentFacts,
  TechnicalDetails,
  readable,
} from "./AnswerCards";
import type {
  AskLloydResponse,
  ExploreGraph,
  Source,
  Trace,
  Precedent,
} from "../../../../packages/ask/src/contracts";
const Scene = dynamic(
  () => import("../evidence-constellation/ConstellationScene"),
  { ssr: false, loading: () => <p>Loading constellation…</p> },
);
type Result = AskLloydResponse & {
  graphs: { evidence: ExploreGraph; precedents: ExploreGraph };
  sources: Source[];
  trace: Trace;
  precedents: Precedent[];
};
class SceneBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? (
      <p>3D unavailable. Use the ranked list.</p>
    ) : (
      this.props.children
    );
  }
}
async function jsonRequest(path: string, body?: unknown) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error?.message ?? "Request failed");
  return value;
}
export function AskWorkspace({ caseId: initialCaseId }: { caseId?: string }) {
  const [reset, setReset] = useState(0);
  const [caseId, setCaseId] = useState(initialCaseId ?? ""),
    [session, setSession] = useState<string>(),
    [question, setQuestion] = useState(""),
    [result, setResult] = useState<Result>(),
    [history, setHistory] = useState<
      Array<{ question: string; result: Result }>
    >([]),
    [mode, setMode] = useState<"evidence" | "precedents">("evidence"),
    [list, setList] = useState(true),
    [can3d, setCan3d] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [selected, setSelected] = useState<string>(),
    [source, setSource] = useState<Source>(),
    [detail, setDetail] = useState<unknown>(),
    [pinned, setPinned] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    [hover, setHover] = useState(""),
    [stateFilter, setStateFilter] = useState("");
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)"),
      small = window.matchMedia("(max-width: 768px)");
    const update = () => {
      try {
        const canvas = document.createElement("canvas");
        const capable = !!canvas.getContext("webgl2") && !reduced.matches;
        setCan3d(capable);
        setList(!capable || small.matches);
      } catch {
        setCan3d(false);
        setList(true);
      }
    };
    update();
    reduced.addEventListener("change", update);
    small.addEventListener("change", update);
    return () => {
      reduced.removeEventListener("change", update);
      small.removeEventListener("change", update);
    };
  }, []);
  const graph = result?.graphs[mode];
  const filtered = useMemo(
    () =>
      graph
        ? {
            ...graph,
            nodes: graph.nodes.filter(
              (n) => n.type === "anchor" || !filter || n.type === filter,
            ),
            edges: graph.edges.filter((e) =>
              [e.source, e.target].every((id) =>
                graph.nodes.some(
                  (n) =>
                    n.id === id &&
                    (n.type === "anchor" || !filter || n.type === filter),
                ),
              ),
            ),
          }
        : undefined,
    [graph, filter],
  );
  async function select(
    id: string,
    pin = false,
    citation?: Source,
    selectionMode = mode,
  ) {
    setSelected(id);
    setSource(
      citation ??
        result?.sources.find(
          (s) => (mode === "evidence" ? s.documentId : s.caseId) === id,
        ),
    );
    if (pin)
      setPinned((p) =>
        p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-5),
      );
    setDetail(undefined);
    if (result)
      try {
        setDetail(
          await jsonRequest(
            `/api/explore/${selectionMode}/nodes/${encodeURIComponent(id)}?answerId=${encodeURIComponent(result.answerId)}`,
          ),
        );
      } catch {
        /* Canonical fact citations have no document node; their exact source remains visible. */
      }
  }
  async function ask(text = question) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    setProgress("Interpreting question…");
    try {
      const id =
        session ??
        (await jsonRequest("/api/ask/sessions", caseId ? { caseId } : {}))
          .sessionId;
      setSession(id);
      const response = await fetch(`/api/ask/sessions/${id}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          question: text,
          caseId: caseId || undefined,
          activeMode: mode,
          pinnedNodeIds: pinned,
          filters: stateFilter ? { state: stateFilter } : {},
        }),
      });
      if (!response.ok) {
        const e = await response.json();
        throw new Error(e.error?.message ?? "Question failed");
      }
      if (!response.body) throw new Error("No response stream");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        completed = false;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = block.match(/^event: (.+)$/m)?.[1],
            dataLine = block.match(/^data: (.+)$/m)?.[1];
          if (!dataLine) continue;
          const data = JSON.parse(dataLine);
          if (event === "intent")
            setProgress(
              `I’m checking ${data.effectiveScope.caseId ? "the selected case" : "the filtered portfolio"}…`,
            );
          if (event === "retrieval_started")
            setProgress("I’m looking through the relevant records…");
          if (event === "retrieval_results")
            setProgress(
              `${data.count} sources found. I’m checking their support…`,
            );
          if (event === "error") throw new Error(data.message);
          if (event === "completed") {
            completed = true;
            setResult(data);
            if (data.graphs[mode].projectionVersion === "unavailable")
              setList(true);
            setHistory((h) => [...h, { question: text, result: data }]);
            setSelected(undefined);
            setSource(undefined);
            setDetail(undefined);
            setFilter("");
            setQuestion("");
            if (
              data.graphs.precedents.nodes.length > 1 &&
              data.graphs.evidence.nodes.length <= 1
            )
              setMode("precedents");
          }
        }
        if (done) break;
      }
      if (!completed)
        throw new Error("The response stream ended early. Retry the question.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Question failed");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  async function demo() {
    setBusy(true);
    try {
      const d = await jsonRequest("/api/ask/demo", {});
      setCaseId(d.caseId);
      setSession(undefined);
      setError("");
      setQuestion("What evidence contradicts sprinkler coverage?");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Demo unavailable");
    } finally {
      setBusy(false);
    }
  }
  const types = [
    ...new Set(
      graph?.nodes.filter((n) => n.type !== "anchor").map((n) => n.type),
    ),
  ];
  const sourceRows =
    mode === "evidence"
      ? result?.sources.filter(
          (s) => s.documentId && (!filter || s.sourceType === filter),
        )
      : result?.sources.filter(
          (s) =>
            s.sourceType === "precedent" &&
            (!filter ||
              result.precedents.some(
                (p) => p.caseId === s.caseId && p.decision === filter,
              )),
        );
  const rows = [
    ...new Map(
      sourceRows?.map((s) => [
        mode === "evidence" ? s.documentId : s.caseId,
        s,
      ]),
    ).values(),
  ];
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl text-navy">Ask Lloyd</h1>
          <p className="text-sm text-muted">
            Source-grounded answers and evidence constellation
          </p>
        </div>
        {initialCaseId && (
          <Link href={`/cases/${encodeURIComponent(initialCaseId)}`}>
            Back to case
          </Link>
        )}
        <button
          className="rounded border px-3 py-2 text-sm"
          onClick={demo}
          disabled={busy}
        >
          Load synthetic demo
        </button>
      </header>
      {!initialCaseId && (
        <div className="flex gap-3">
          <label>
            Case ID
            <input
              aria-label="Case ID"
              className="ml-2 rounded border p-2"
              value={caseId}
              onChange={(e) => {
                setCaseId(e.target.value);
                setSession(undefined);
                setHistory([]);
                setResult(undefined);
                setPinned([]);
                setSource(undefined);
                setDetail(undefined);
              }}
            />
          </label>
          <label>
            State filter
            <input
              aria-label="State filter"
              maxLength={2}
              className="ml-2 w-16 rounded border p-2"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value.toUpperCase())}
            />
          </label>
        </div>
      )}
      <p className="text-xs text-muted">
        Scope:{" "}
        {caseId || "Authorized portfolio — an explicit filter is required"}.
        Read-only · session retention: 7 days by default.
      </p>
      <div className="grid gap-4 xl:grid-cols-[minmax(320px,1fr)_minmax(400px,1.4fr)]">
        <section
          className="space-y-4 rounded-lg border bg-white p-4"
          aria-label="Chat"
        >
          {history.length > 0 && (
            <details>
              <summary>Question history ({history.length})</summary>
              {history.map((h, i) => (
                <button
                  key={i}
                  className="block py-2 text-left underline"
                  onClick={() => {
                    setResult(h.result);
                    setSelected(undefined);
                    setSource(undefined);
                    setDetail(undefined);
                  }}
                >
                  {h.question}
                </button>
              ))}
            </details>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <label
              htmlFor="ask-question"
              className="block text-sm font-semibold"
            >
              Ask an underwriting question
            </label>
            <textarea
              id="ask-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={1500}
              rows={3}
              className="mt-2 w-full rounded border p-3"
              placeholder="What evidence contradicts sprinkler coverage?"
            />
            <button
              type="submit"
              disabled={busy || question.trim().length < 3}
              className="mt-2 rounded bg-navy px-4 py-2 text-white disabled:opacity-50"
            >
              {busy ? "Retrieving…" : "Ask Lloyd"}
            </button>
          </form>
          <div role="status" aria-live="polite">
            {progress}
          </div>
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          {result && (
            <>
              <AnswerCards
                answer={result}
                onSource={(s) => {
                  const nextMode =
                    s.sourceType === "precedent" ? "precedents" : "evidence";
                  setMode(nextMode);
                  setFilter("");
                  void select(s.documentId ?? s.caseId, false, s, nextMode);
                }}
              />
              <SearchCards trace={result.trace} />
              <section aria-label="Suggested follow-ups" className="space-y-2">
                <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <MessageSquarePlus size={14} />
                  Keep exploring
                </h2>
                {result.suggestedQuestions.map((q) => (
                  <button
                    disabled={busy}
                    key={q}
                    className="group flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-3 text-left text-xs leading-5 text-slate-700 hover:border-teal-300 hover:bg-teal-50 disabled:opacity-50"
                    onClick={() => void ask(q)}
                  >
                    <span>{q}</span>
                    <ArrowRight size={14} className="shrink-0 text-teal-700" />
                  </button>
                ))}
              </section>
            </>
          )}
          {session && (
            <button
              className="inline-flex items-center gap-2 rounded-md px-2 py-2 text-xs text-slate-500 hover:bg-red-50 hover:text-red-700"
              disabled={busy}
              onClick={async () => {
                const r = await fetch(`/api/ask/sessions/${session}`, {
                  method: "DELETE",
                });
                if (r.ok) {
                  setSession(undefined);
                  setResult(undefined);
                  setHistory([]);
                  setSource(undefined);
                  setDetail(undefined);
                  setSelected(undefined);
                  setPinned([]);
                } else setError("Session could not be deleted");
              }}
            >
              <Trash2 size={13} />
              Delete conversation and saved answers
            </button>
          )}
        </section>
        <section
          className="space-y-3 rounded-lg border bg-white p-4"
          aria-label="Evidence constellation"
        >
          <div className="flex flex-wrap gap-2">
            {(["evidence", "precedents"] as const).map((m) => (
              <button
                key={m}
                disabled={m === "precedents" && !caseId}
                aria-pressed={mode === m}
                className={`rounded border px-3 py-2 ${mode === m ? "bg-navy text-white" : ""}`}
                onClick={() => {
                  setMode(m);
                  setFilter("");
                  setSource(undefined);
                  setDetail(undefined);
                }}
              >
                {m === "evidence" ? "Evidence" : "Precedents"}
              </button>
            ))}
            <button
              aria-pressed={list}
              className="rounded border px-3 py-2"
              onClick={() => setList(true)}
            >
              List
            </button>
            <button
              disabled={!can3d}
              aria-pressed={!list}
              className="rounded border px-3 py-2 disabled:opacity-40"
              onClick={() => setList(false)}
            >
              3D map
            </button>
            <button
              className="text-xs underline"
              onClick={() => {
                setReset((r) => r + 1);
                setFilter("");
                setPinned([]);
                setSelected(undefined);
                setSource(undefined);
                setDetail(undefined);
              }}
            >
              Reset to answer
            </button>
          </div>
          <label className="text-sm">
            Filter / legend{" "}
            <select
              aria-label="Source filter"
              className="ml-2 rounded border p-1"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">All sources</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {readable(t)}
                </option>
              ))}
            </select>
          </label>
          {graph && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">About this map</summary>
              <p className="my-2 leading-5">{graph.notice}</p>
              <TechnicalDetails
                value={{
                  projectionVersion: graph.projectionVersion,
                  mode: graph.mode,
                }}
                label="Map details · JSON"
              />
            </details>
          )}
          {!result && (
            <p className="py-16 text-center text-muted">
              Ask a question to explore its sources.
            </p>
          )}
          {filtered && !list && filtered.nodes.length > 0 && (
            <SceneBoundary
              onFailure={() => {
                setCan3d(false);
                setList(true);
              }}
            >
              <Scene
                reset={reset}
                graph={filtered}
                selected={selected}
                onSelect={(id, pin) => void select(id, pin)}
                onHover={setHover}
                onFailure={() => {
                  setCan3d(false);
                  setList(true);
                }}
              />
            </SceneBoundary>
          )}
          {hover && (
            <p className="text-xs" role="status">
              {hover}
            </p>
          )}
          <ol
            aria-label="Ranked sources"
            className={list ? "space-y-2" : "flex flex-wrap gap-2"}
          >
            {rows.map((s) => {
              const id = (mode === "evidence" ? s.documentId : s.caseId)!;
              return (
                <li
                  key={id}
                  className={`rounded border p-3 ${selected === id ? "border-teal-600 bg-teal-50" : ""}`}
                >
                  <button
                    className="text-left text-sm font-semibold"
                    onClick={() => void select(id, false, s)}
                  >
                    {s.label}
                    {s.page ? ` · p. ${s.page}` : ""}
                  </button>
                  {list && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusTag value={s.verificationStatus} />
                      <span className="text-xs text-slate-500">
                        {readable(s.sourceType)}
                      </span>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <button
                      className="rounded-md border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50"
                      aria-pressed={pinned.includes(id)}
                      onClick={() => void select(id, true, s)}
                    >
                      {pinned.includes(id) ? "Unpin" : "Pin for comparison"}
                    </button>
                    <button
                      className="rounded-md border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-teal-900 hover:bg-teal-100"
                      onClick={() =>
                        setQuestion((q) => `${q} [source: ${s.evidenceId}]`)
                      }
                    >
                      Use in question
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          {result && !rows.length && (
            <p>
              No sources in this mode.{" "}
              {mode === "precedents"
                ? "Select a case and ask for similar precedents."
                : "Try a more specific evidence question."}
            </p>
          )}
        </section>
      </div>
      {pinned.length > 0 && (
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold">Pinned comparison</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {pinned.map((id) => {
              const p = result?.precedents.find((p) => p.caseId === id);
              const s = result?.sources.find(
                (s) => s.documentId === id || s.caseId === id,
              );
              return (
                <article key={id} className="rounded border p-3">
                  <h3>{s?.label ?? id}</h3>
                  <p className="text-sm">{s?.excerpt}</p>
                  {p && <PrecedentFacts precedent={p} />}
                </article>
              );
            })}
          </div>
        </section>
      )}
      {source && (
        <SourceCard
          source={source}
          detail={detail}
          precedent={result?.precedents.find((p) => p.caseId === source.caseId)}
          onClose={() => setSource(undefined)}
          onUse={() =>
            setQuestion((q) => `${q} [source: ${source.evidenceId}]`)
          }
        />
      )}
    </div>
  );
}

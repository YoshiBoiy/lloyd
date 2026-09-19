"use client";

import { useCallback, useEffect, useState } from "react";
import { getLloydApi, subscribeLloydApi } from "@/lib/api";
import type { CaseDetail, CaseListFilters, CaseListResponse, IntakeDocument } from "@/lib/api/types";

export function useLloydSnapshot<T>(loader: () => Promise<T>, deps: unknown[] = []): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    return subscribeLloydApi(() => setTick((value) => value + 1));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { data, error, loading, reload };
}

export function useCaseList(filters: CaseListFilters) {
  return useLloydSnapshot(() => getLloydApi().listCases(filters), [
    filters.search,
    filters.state,
    filters.decision,
    filters.assignee,
    filters.stage,
  ]);
}

export function useCase(id: string) {
  return useLloydSnapshot((): Promise<CaseDetail> => getLloydApi().getCase(id), [id]);
}

export function useIntake() {
  return useLloydSnapshot((): Promise<IntakeDocument> => getLloydApi().getIntake(), []);
}

export function useQueue(): { data: CaseListResponse | null } {
  return useLloydSnapshot(() => getLloydApi().listCases(), []);
}

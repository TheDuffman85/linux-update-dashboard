import { useEffect, useRef, useState } from "react";
import { OUTPUT_RULE_PATTERN_TIMEOUT_MS, type OutputRule } from "../../shared/output-rules";
import type {
  OutputRulePreviewInput,
  OutputRulePreviewRequest,
  OutputRulePreviewResponse,
  OutputRulePreviewState,
} from "./output-rules-preview-core";

export {
  evaluatePreviewRequest,
  patternKey,
  type OutputRulePreviewInput,
  type OutputRulePreviewRequest,
  type OutputRulePreviewResponse,
  type OutputRulePreviewState,
} from "./output-rules-preview-core";

/** The part of a Worker the runner uses, so tests can provide a fake one. */
export interface PreviewWorker {
  postMessage(request: OutputRulePreviewRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<OutputRulePreviewResponse>) => void): void;
  terminate(): void;
}

/** Extra time over the pattern limit for messages between the page and the worker. */
const PATTERN_GRACE_MS = 150;
/** Gives up when the worker does not even start, for example when it fails to load. */
export const OUTPUT_RULE_PREVIEW_TIMEOUT_MS = 10_000;

interface PendingPreview {
  id: number;
  rules: OutputRule[];
  input: OutputRulePreviewInput;
  skipPatterns: Set<string>;
  currentPattern: string | null;
  patternTimer: ReturnType<typeof setTimeout> | null;
  overallTimer: ReturnType<typeof setTimeout>;
  resolve: (state: OutputRulePreviewState) => void;
}

/**
 * Runs previews in a worker. A pattern that does not finish within the shared limit
 * (plus a little messaging time) is skipped: the worker is stopped and the rules are
 * tried again in a new one, as the server skips such a pattern and goes on.
 */
export class OutputRulePreviewRunner {
  private worker: PreviewWorker | null = null;
  private nextId = 0;
  private pending: PendingPreview | null = null;

  constructor(
    private readonly createWorker: () => PreviewWorker,
    private readonly patternTimeoutMs = OUTPUT_RULE_PATTERN_TIMEOUT_MS + PATTERN_GRACE_MS,
    private readonly overallTimeoutMs = OUTPUT_RULE_PREVIEW_TIMEOUT_MS,
  ) {}

  run(rules: OutputRule[], input: OutputRulePreviewInput): Promise<OutputRulePreviewState> {
    // A newer request replaces the one in progress, which may be stuck in a pattern.
    if (this.pending) this.stopWorker();
    this.settle({ status: "idle" });
    return new Promise((resolve) => {
      const pending: PendingPreview = {
        id: 0,
        rules,
        input,
        skipPatterns: new Set(),
        currentPattern: null,
        patternTimer: null,
        overallTimer: setTimeout(() => {
          if (this.pending !== pending) return;
          this.settle({ status: "timeout" });
          this.stopWorker();
        }, this.overallTimeoutMs),
        resolve,
      };
      this.pending = pending;
      this.attempt(pending);
    });
  }

  dispose(): void {
    this.settle({ status: "idle" });
    this.stopWorker();
  }

  private attempt(pending: PendingPreview): void {
    pending.id = ++this.nextId;
    pending.currentPattern = null;
    this.ensureWorker().postMessage({
      id: pending.id,
      rules: pending.rules,
      input: pending.input,
      skipPatterns: [...pending.skipPatterns],
    });
  }

  private ensureWorker(): PreviewWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener("message", (event) => this.receive(event.data));
    this.worker = worker;
    return worker;
  }

  private receive(response: OutputRulePreviewResponse): void {
    const pending = this.pending;
    if (!pending || pending.id !== response.id) return;
    if (response.type === "result") {
      this.settle({ status: "done", match: response.match, slowRules: response.slowRules });
      return;
    }
    pending.currentPattern = response.key;
    if (pending.patternTimer) clearTimeout(pending.patternTimer);
    pending.patternTimer = setTimeout(() => this.skipStuckPattern(pending), this.patternTimeoutMs);
  }

  private skipStuckPattern(pending: PendingPreview): void {
    if (this.pending !== pending || !pending.currentPattern) return;
    pending.skipPatterns.add(pending.currentPattern);
    this.stopWorker();
    this.attempt(pending);
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private settle(state: OutputRulePreviewState): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.patternTimer) clearTimeout(pending.patternTimer);
    clearTimeout(pending.overallTimer);
    this.pending = null;
    pending.resolve(state);
  }
}

function createBrowserWorker(): PreviewWorker {
  return new Worker(new URL("./output-rules-preview.worker.ts", import.meta.url), { type: "module" }) as PreviewWorker;
}

/** Tries the rules shortly after the inputs stop changing. Returns idle where workers are unavailable. */
export function useOutputRulePreview(
  rules: OutputRule[],
  input: OutputRulePreviewInput | null,
  delayMs = 250,
): OutputRulePreviewState {
  const runnerRef = useRef<OutputRulePreviewRunner | null>(null);
  const [state, setState] = useState<OutputRulePreviewState>({ status: "idle" });
  const key = JSON.stringify([rules, input]);

  useEffect(() => () => {
    runnerRef.current?.dispose();
    runnerRef.current = null;
  }, []);

  useEffect(() => {
    if (!input || !rules.length || typeof Worker === "undefined") {
      setState({ status: "idle" });
      return;
    }
    let active = true;
    setState({ status: "pending" });
    const timer = setTimeout(() => {
      runnerRef.current ??= new OutputRulePreviewRunner(createBrowserWorker);
      void runnerRef.current.run(rules, input).then((next) => {
        if (active && next.status !== "idle") setState(next);
      });
    }, delayMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // The serialized key covers rules and input.
  }, [key, delayMs]);

  return state;
}

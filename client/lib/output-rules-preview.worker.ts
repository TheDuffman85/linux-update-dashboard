/// <reference lib="webworker" />
import { evaluatePreviewRequest, type OutputRulePreviewRequest } from "./output-rules-preview-core";

// Rules are tried here, off the page's thread, so a slow pattern cannot freeze the editor.
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<OutputRulePreviewRequest>) => {
  evaluatePreviewRequest(event.data, (response) => scope.postMessage(response));
});

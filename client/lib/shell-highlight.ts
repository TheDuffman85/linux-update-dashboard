import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";

if (!hljs.getLanguage("bash")) {
  hljs.registerLanguage("bash", bashLanguage);
}

hljs.configure({ ignoreUnescapedHTML: true });

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function highlightShell(value: string): string {
  try {
    return hljs.highlight(value || "\n", {
      language: "bash",
      ignoreIllegals: true,
    }).value;
  } catch {
    return escapeHtml(value);
  }
}

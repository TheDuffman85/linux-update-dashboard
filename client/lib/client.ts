const BASE_URL = "/api";
const CSRF_COOKIE = "ludash_csrf";
const CSRF_HEADER = "X-CSRF-Token";

function getCookie(name: string): string | null {
  const entries = document.cookie ? document.cookie.split(";") : [];
  for (const entry of entries) {
    const [rawKey, ...rest] = entry.split("=");
    if (rawKey.trim() !== name) continue;
    return decodeURIComponent(rest.join("="));
  }
  return null;
}

function methodIsUnsafe(method?: string): boolean {
  const normalized = (method || "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (methodIsUnsafe(options.method)) {
    const csrf = getCookie(CSRF_COOKIE);
    if (csrf && !headers.has(CSRF_HEADER)) {
      headers.set(CSRF_HEADER, csrf);
    }
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

// Poll a background job until it completes
export async function pollJob<T>(
  jobId: string,
  intervalMs = 2000,
  maxAttempts = 300 // 10 minutes at 2s interval
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await apiFetch<{ status: string; result?: T }>(
      `/jobs/${jobId}`
    );
    if (job.status === "done") return job.result as T;
    if (job.status === "failed") {
      const err = (job.result as { error?: string })?.error ?? "Job failed";
      throw new ApiError(500, err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new ApiError(504, "Operation timed out");
}

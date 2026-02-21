const BASE_URL = "/api";

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
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
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

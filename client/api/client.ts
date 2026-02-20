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

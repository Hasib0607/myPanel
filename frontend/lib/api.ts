export const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

function readCookie(name: string) {
  if (typeof document === "undefined") return null;
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? null;
}

async function csrfHeader(): Promise<Record<string, string>> {
  let token = readCookie("panel_csrf");
  if (!token) {
    const response = await fetch(`${apiBase}/auth/csrf`, {
      credentials: "include",
      cache: "no-store"
    });
    const data = await response.json().catch(() => null);
    token = data?.token ?? readCookie("panel_csrf");
  }
  return token ? { "x-csrf-token": decodeURIComponent(token) } : {};
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      ...(await csrfHeader())
    }
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

export async function apiDeleteBody<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    cache: "no-store"
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

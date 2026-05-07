function resolveApiBase() {
  const configured = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (!configured) return "/api/v1";

  if (typeof window !== "undefined") {
    const configuredUrl = new URL(configured, window.location.origin);
    const browserIsLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    const apiIsLocal = ["localhost", "127.0.0.1", "::1"].includes(configuredUrl.hostname);
    const sameHostname = configuredUrl.hostname === window.location.hostname;
    const sameOrigin = configuredUrl.origin === window.location.origin;

    if (apiIsLocal && !browserIsLocal) return "/api/v1";
    if (sameHostname && !sameOrigin) return "/api/v1";
  }

  return configured;
}

export const apiBase = resolveApiBase();

function apiUrl(path: string) {
  return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const url = apiUrl(path);
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Could not reach API at ${url}. Check Nginx /api/v1 proxy and API service.`);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `API request failed: ${response.status}`);
  }
  return data as T;
}

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
    let response: Response;
    const url = apiUrl("/auth/csrf");
    try {
      response = await fetch(url, {
        credentials: "include",
        cache: "no-store"
      });
    } catch {
      throw new Error(`Could not reach API at ${url}. Check Nginx /api/v1 proxy and API service.`);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error ?? `CSRF request failed: ${response.status}`);
    }
    token = data?.token ?? readCookie("panel_csrf");
  }
  return token ? { "x-csrf-token": decodeURIComponent(token) } : {};
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "PUT",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return fetchJson<T>(path, {
    method: "DELETE",
    credentials: "include",
    headers: {
      ...(await csrfHeader())
    }
  });
}

export async function apiDeleteBody<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(await csrfHeader())
    },
    body: JSON.stringify(body)
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  return fetchJson<T>(path, {
    credentials: "include",
    cache: "no-store"
  });
}

export async function apiGetText(path: string): Promise<string> {
  const url = apiUrl(path);
  let response: Response;

  try {
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
  } catch {
    throw new Error(`Could not reach API at ${url}. Check Nginx /api/v1 proxy and API service.`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `API request failed: ${response.status}`);
  }
  return text;
}

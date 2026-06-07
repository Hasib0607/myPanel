function resolveApiBase() {
  const configured = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (!configured) return "/api/v1";

  if (typeof window !== "undefined") {
    const configuredUrl = new URL(configured, window.location.origin);
    const configuredPath = configuredUrl.pathname.replace(/\/$/, "");
    const browserIsLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    const apiIsLocal = ["localhost", "127.0.0.1", "::1"].includes(configuredUrl.hostname);
    const sameHostname = configuredUrl.hostname === window.location.hostname;
    const sameOrigin = configuredUrl.origin === window.location.origin;
    const panelPort = process.env.NEXT_PUBLIC_PANEL_LOGIN_PORT || configuredUrl.port;
    const browserUsesDefaultPort = !window.location.port || window.location.port === "80" || window.location.port === "443";
    const sameHostApiBase = () => {
      if (window.location.protocol === "https:" || browserIsLocal || !browserUsesDefaultPort || !panelPort) {
        return "/api/v1";
      }
      return `${window.location.protocol}//${window.location.hostname}:${panelPort}/api/v1`;
    };

    if (configuredPath === "/api/v1" && !browserIsLocal) return sameHostApiBase();
    if (window.location.protocol === "https:" && configuredUrl.protocol === "http:") return sameHostApiBase();
    if (apiIsLocal && !browserIsLocal) return sameHostApiBase();
    if (sameHostname && !sameOrigin) return sameHostApiBase();
  }

  return configured;
}

export const apiBase = resolveApiBase();

function apiUrl(path: string) {
  return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
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
    if (response.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.assign(apiUrl("/auth/logout?next=/login"));
    }
    const issueText = Array.isArray(data?.issues)
      ? data.issues
          .map((issue: { path?: string; message?: string }) => [issue.path, issue.message].filter(Boolean).join(": "))
          .filter(Boolean)
          .join("; ")
      : "";
    throw new ApiError(issueText || data?.error || `API request failed: ${response.status}`, response.status, data);
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

async function jsonRequestInit(method: "POST" | "PATCH" | "PUT", body?: unknown): Promise<RequestInit> {
  const headers: Record<string, string> = {
    ...(await csrfHeader())
  };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  };
}

async function uploadRequestInit(body: BodyInit, contentType: string, headers?: Record<string, string>): Promise<RequestInit> {
  return {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": contentType,
      ...(await csrfHeader()),
      ...(headers ?? {})
    },
    body
  };
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, await jsonRequestInit("POST", body));
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, await jsonRequestInit("PATCH", body));
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, await jsonRequestInit("PUT", body));
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

export async function apiUpload<T>(path: string, body: BodyInit, contentType: string, headers?: Record<string, string>): Promise<T> {
  return fetchJson<T>(path, await uploadRequestInit(body, contentType, headers));
}

export async function apiUploadWithProgress<T>(
  path: string,
  body: XMLHttpRequestBodyInit | Document,
  contentType: string,
  onProgress: (percent: number, loaded: number, total: number) => void,
  headers?: Record<string, string>,
  timeoutMs = 3_600_000
): Promise<T> {
  const url = apiUrl(path);
  const csrf = await csrfHeader();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const bodySize = body instanceof Blob ? body.size : 1;
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("content-type", contentType);
    for (const [key, value] of Object.entries({ ...csrf, ...(headers ?? {}) })) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)), event.loaded, event.total);
      }
    };
    xhr.onload = () => {
      let data: { error?: string } | null = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        reject(new Error(`Upload response was not valid JSON (${xhr.status}).`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100, bodySize, bodySize);
        resolve(data as T);
      } else {
        reject(new Error(data?.error ?? `API request failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error(`Could not reach API at ${url}. Check Nginx /api/v1 proxy and API service.`));
    xhr.ontimeout = () => reject(new Error(`Upload timed out at ${url}. Check Nginx client_max_body_size and proxy timeouts.`));
    xhr.send(body);
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

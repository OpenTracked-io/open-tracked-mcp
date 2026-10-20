/** A small client for the Open Tracked API (/api/v1, Sanctum bearer token). */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export class OpenTrackedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class OpenTrackedClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.base = baseUrl.replace(/\/+$/, "") + "/api/v1";
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) {
      throw new OpenTrackedError(
        "OPEN_TRACKED_TOKEN is not set. Create a token in Open Tracked under Settings, MCP, and put it in the server's environment.",
        401,
      );
    }
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j?.message ?? (j?.errors ? JSON.stringify(j.errors) : "");
      } catch {
        /* the body was not JSON */
      }
      const hint =
        res.status === 401 ? " The token is wrong or was removed." : res.status === 404 ? " Not found, or it is not yours." : "";
      throw new OpenTrackedError(`Open Tracked answered ${res.status}.${hint} ${detail}`.trim(), res.status);
    }
    const json = await res.json();
    return (json && typeof json === "object" && "data" in json ? json.data : json) as T;
  }

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

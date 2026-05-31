import https from "node:https";
import { URL } from "node:url";

export type WhmClientConfig = {
  host: string;
  port: number;
  username: string;
  token: string;
  verifySsl: boolean;
};

export class WhmClient {
  constructor(private readonly config: WhmClientConfig) {}

  async request<T = any>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(`https://${this.config.host}:${this.config.port}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(url, {
        method: "GET",
        rejectUnauthorized: this.config.verifySsl,
        headers: {
          authorization: `whm ${this.config.username}:${this.config.token}`,
          accept: "application/json"
        }
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`WHM API ${url.pathname} failed with HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          resolve(data);
        });
      });
      req.on("error", reject);
      req.end();
    });

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`WHM API ${url.pathname} returned non-JSON response`);
    }
  }

  version() {
    return this.request("/json-api/version", { "api.version": 1 });
  }

  listAccounts() {
    return this.request("/json-api/listaccts", { "api.version": 1 });
  }

  listPackages() {
    return this.request("/json-api/listpkgs", { "api.version": 1 });
  }

  listDatabases(user: string) {
    return this.request("/json-api/cpanel", {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: "Mysql",
      cpanel_jsonapi_func: "list_databases"
    });
  }

  listMailboxes(user: string) {
    return this.request("/json-api/cpanel", {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: "Email",
      cpanel_jsonapi_func: "list_pops"
    });
  }

  listDomains(user: string) {
    return this.request("/json-api/cpanel", {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: "DomainInfo",
      cpanel_jsonapi_func: "domains_data",
      format: "hash"
    });
  }

  installedHosts(user: string) {
    return this.request("/json-api/cpanel", {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: "SSL",
      cpanel_jsonapi_func: "installed_hosts"
    });
  }

  dumpZone(domain: string) {
    return this.request("/json-api/dumpzone", { "api.version": 1, domain });
  }
}

export function cpanelData(response: any): any[] {
  const result = response?.cpanelresult?.result;
  if (result?.data && Array.isArray(result.data)) return result.data;
  const data = response?.cpanelresult?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

export function whmData(response: any, key: string): any[] {
  const data = response?.data?.[key] ?? response?.[key];
  return Array.isArray(data) ? data : [];
}

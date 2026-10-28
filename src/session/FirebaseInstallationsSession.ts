import { HttpClient } from "../http/HttpClient";

export interface FirebaseInstallationsOptions {
  readonly projectId: string;
  readonly appId: string;
  readonly apiKey: string;
  readonly sdkVersion: string;
}

interface AuthToken {
  readonly token: string;
  readonly expiresAt: number;
}

interface InstallationSession {
  readonly fid: string;
  readonly refreshToken: string;
  readonly authToken: AuthToken;
}

const validFid = /^[cdef][\w-]{21}$/;
const refreshBufferMs = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHeaderValue(value: unknown): value is string {
  return isNonemptyString(value) && /^[\x21-\x7e]+$/.test(value);
}

function generateFid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  // Firebase reserves the first four bits for the 0111 FID prefix.
  bytes[0] = 0x70 | ((bytes[0] ?? 0) & 0x0f);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, 22);
}

export class FirebaseInstallationsSession {
  private readonly options: FirebaseInstallationsOptions;
  private readonly http: HttpClient;
  private readonly installationsPath: string;
  private session: InstallationSession | undefined;
  private pendingToken: Promise<string> | undefined;

  constructor(options: FirebaseInstallationsOptions, http?: HttpClient) {
    for (const key of ["projectId", "appId", "apiKey", "sdkVersion"] as const) {
      if (!isNonemptyString(options[key])) {
        throw new TypeError(`Firebase Installations ${key} must be nonempty`);
      }
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(options.projectId)) {
      throw new TypeError("Firebase Installations projectId must be a project identifier");
    }
    if (!isHeaderValue(options.apiKey)) {
      throw new TypeError("Firebase Installations apiKey must be header-safe ASCII");
    }

    this.options = { ...options };
    this.http = http ?? new HttpClient({
      baseUrl: "https://firebaseinstallations.googleapis.com/v1/",
    });
    this.installationsPath = `projects/${encodeURIComponent(options.projectId)}/installations`;
  }

  async getAuthToken(): Promise<string> {
    if (this.session && this.session.authToken.expiresAt > Date.now() + refreshBufferMs) {
      return this.session.authToken.token;
    }
    if (this.pendingToken) return this.pendingToken;

    const pending = this.obtainAuthToken().finally(() => {
      this.pendingToken = undefined;
    });
    this.pendingToken = pending;
    return pending;
  }

  private async obtainAuthToken(): Promise<string> {
    const session = this.session;
    if (session) {
      const requestedAt = Date.now();
      const response = await this.http.post<unknown>(
        `${this.installationsPath}/${encodeURIComponent(session.fid)}/authTokens:generate`,
        { installation: { appId: this.options.appId, sdkVersion: this.options.sdkVersion } },
        { headers: { ...this.headers(), Authorization: `FIS_v2 ${session.refreshToken}` } },
      );
      const authToken = this.parseAuthToken(response.data, requestedAt);
      // Keep the installation intact when refreshing fails; callers choose when to try again.
      this.session = { ...session, authToken };
      return authToken.token;
    }

    const requestedAt = Date.now();
    const response = await this.http.post<unknown>(
      this.installationsPath,
      {
        fid: generateFid(),
        authVersion: "FIS_v2",
        appId: this.options.appId,
        sdkVersion: this.options.sdkVersion,
      },
      { headers: this.headers() },
    );
    const data = response.data;
    if (
      !isRecord(data)
      || !isNonemptyString(data["name"])
      || typeof data["fid"] !== "string"
      || !validFid.test(data["fid"])
      || !isHeaderValue(data["refreshToken"])
    ) {
      throw new TypeError("Invalid Firebase installation response");
    }

    const authToken = this.parseAuthToken(data["authToken"], requestedAt);
    this.session = { fid: data["fid"], refreshToken: data["refreshToken"], authToken };
    return authToken.token;
  }

  private headers(): Record<string, string> {
    return { Accept: "application/json", "x-goog-api-key": this.options.apiKey };
  }

  private parseAuthToken(value: unknown, requestedAt: number): AuthToken {
    if (
      !isRecord(value)
      || !isHeaderValue(value["token"])
      || typeof value["expiresIn"] !== "string"
      || !/^\d+(?:\.\d{1,9})?s$/.test(value["expiresIn"])
    ) {
      throw new TypeError("Invalid Firebase installation auth token response");
    }

    const durationMs = Number(value["expiresIn"].slice(0, -1)) * 1_000;
    const expiresAt = requestedAt + durationMs;
    if (
      !Number.isFinite(durationMs)
      || durationMs <= 0
      || !Number.isFinite(expiresAt)
      || Math.abs(expiresAt) > Number.MAX_SAFE_INTEGER
    ) {
      throw new TypeError("Invalid Firebase installation token expiry");
    }

    return { token: value["token"], expiresAt };
  }
}

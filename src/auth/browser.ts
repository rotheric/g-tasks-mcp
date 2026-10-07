import type { Request, Response, Express, CookieOptions } from "express";
import express from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  GOOGLE_TASKS_SCOPE,
  issuerFor,
  resourceFor,
  type Configuration,
  type AccessProfile,
} from "../config.js";
import { Storage, type Revision } from "../storage.js";
import {
  checkResource,
  equal,
  randomToken,
  redirectIdentity,
  redirectMatches,
  scopes,
  validateClient,
} from "./policy.js";
import type { GooglePort } from "./google-identity.js";

interface Session {
  id: string;
  cookie: string;
  createdAt: number;
  seenAt: number;
  csrf: string;
  owner?: string;
}
interface Transaction {
  resource: string;
  issuer: string;
  id: string;
  sessionId: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  revision: Revision;
  expiresAt: number;
  csrf: string;
  stage: "owner" | "google" | "exchange";
  purpose?: "identity" | "tasks";
  state?: string;
  nonce?: string;
}
export interface IssuedCode {
  resource: string;
  issuer: string;
  clientId: string;
  redirect: string;
  challenge: string;
  revision: Revision;
  expiresAt: number;
  sessionId: string;
}
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function page(res: Response, title: string, content: string): void {
  res
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1>${content}</main></body></html>`,
    );
}

/** Browser approval is a separate capability from upstream account credentials. */
export class BrowserAuthorization {
  private sessions = new Map<string, Session>();
  private transactions = new Map<string, Transaction>();
  readonly codes = new Map<string, IssuedCode>();
  private cookieName: string;
  constructor(
    readonly store: Storage,
    readonly c: Configuration,
    readonly google: GooglePort,
    readonly now: () => number = Date.now,
  ) {
    this.cookieName = c.mode === "hosted" ? "__Host-gtasks" : "gtasks-local";
  }
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.c.mode === "hosted",
      sameSite: "lax",
      path: "/",
    };
  }
  private cookie(res: Response, value: string): void {
    res.cookie(this.cookieName, value, {
      ...this.cookieOptions(),
      maxAge: 8 * 3600 * 1000,
    });
  }
  private prune(): void {
    const now = this.now();
    for (const [id, s] of this.sessions)
      if (
        now - s.createdAt >= 8 * 3600 * 1000 ||
        now - s.seenAt >= 30 * 60 * 1000
      )
        this.sessions.delete(id);
    for (const [id, t] of this.transactions)
      if (now >= t.expiresAt || !this.sessions.has(t.sessionId))
        this.transactions.delete(id);
    for (const [id, c] of this.codes)
      if (now >= c.expiresAt || !this.sessions.has(c.sessionId))
        this.codes.delete(id);
  }
  session(req: Request, res?: Response): Session | undefined {
    this.prune();
    const value = (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(this.cookieName + "="))
      ?.slice(this.cookieName.length + 1);
    let s = [...this.sessions.values()].find((s) => s.cookie === value);
    if (!s && res) {
      if (this.sessions.size >= 100)
        throw new InvalidRequestError("Browser session capacity reached");
      s = {
        id: randomToken(),
        cookie: randomToken(),
        createdAt: this.now(),
        seenAt: this.now(),
        csrf: randomToken(),
      };
      this.sessions.set(s.id, s);
      this.cookie(res, s.cookie);
    }
    if (s) s.seenAt = this.now();
    return s;
  }
  private valid(t: Transaction): boolean {
    this.prune();
    return (
      this.transactions.get(t.id) === t &&
      this.now() < t.expiresAt &&
      this.sessions.has(t.sessionId) &&
      this.store.isCurrent(t.revision, t.client.client_id)
    );
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
    identity: Pick<AccessProfile, "resource" | "issuer"> = {
      resource: resourceFor(this.c),
      issuer: issuerFor(this.c),
    },
  ): Promise<void> {
    validateClient(client);
    scopes(params.scopes);
    checkResource(params.resource, identity.resource);
    if (
      !client.redirect_uris.some((uri) =>
        redirectMatches(params.redirectUri, uri),
      )
    )
      throw new InvalidRequestError("Unregistered callback");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("Invalid S256 challenge");
    if (!this.store.snapshot().owner)
      throw new InvalidRequestError("Owner setup is required");
    const session = this.session(res.req as Request, res)!;
    if (this.transactions.size >= 100)
      throw new InvalidRequestError("Authorization capacity reached");
    const t: Transaction = {
      resource: identity.resource,
      issuer: identity.issuer,
      id: randomToken(),
      sessionId: session.id,
      client,
      params,
      revision: this.store.revision(client.client_id),
      expiresAt: this.now() + 10 * 60 * 1000,
      csrf: randomToken(),
      stage: "owner",
    };
    this.transactions.set(t.id, t);
    if (
      session.owner === this.store.snapshot().owner &&
      this.store.approved(
        client.client_id,
        redirectIdentity(params.redirectUri),
        t.resource,
      ) &&
      this.store.readGoogleTokens()
    ) {
      this.complete(t, res);
      return;
    }
    if (session.owner !== this.store.snapshot().owner) {
      this.startGoogle(t, "identity", res);
      return;
    }
    res.redirect(`/auth/consent?id=${t.id}`);
  }
  private clientRedirect(
    t: Transaction,
    values: Record<string, string>,
  ): string {
    const u = new URL(t.params.redirectUri);
    for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
    u.searchParams.set("iss", t.issuer);
    if (t.params.state !== undefined)
      u.searchParams.set("state", t.params.state);
    return u.href;
  }
  private complete(t: Transaction, res: Response): void {
    const s = this.sessions.get(t.sessionId);
    if (
      !this.valid(t) ||
      s?.owner !== this.store.snapshot().owner ||
      !this.store.readGoogleTokens() ||
      !this.store.approved(
        t.client.client_id,
        redirectIdentity(t.params.redirectUri),
        t.resource,
      )
    )
      throw new Error("Authorization no longer valid");
    const code = randomToken();
    this.codes.set(code, {
      resource: t.resource,
      issuer: t.issuer,
      clientId: t.client.client_id,
      redirect: t.params.redirectUri,
      challenge: t.params.codeChallenge,
      revision: t.revision,
      expiresAt: this.now() + 5 * 60 * 1000,
      sessionId: t.sessionId,
    });
    this.transactions.delete(t.id);
    res.redirect(this.clientRedirect(t, { code }));
  }
  code(value: string): IssuedCode | undefined {
    this.prune();
    const c = this.codes.get(value);
    if (
      !c ||
      this.now() >= c.expiresAt ||
      !this.store.isCurrent(c.revision, c.clientId) ||
      this.sessions.get(c.sessionId)?.owner !== this.store.snapshot().owner
    )
      return;
    return c;
  }
  private show(t: Transaction, res: Response): void {
    const name = t.client.client_name ?? "Unnamed application";
    // Chromium/Safari also apply form-action to redirects after submission.
    // Permit Google and this transaction's validated client callback, so a
    // successful POST can navigate there without leaving a stale form behind.
    const callbackOrigin = new URL(t.params.redirectUri).origin;
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; form-action 'self' https://accounts.google.com ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    const fields = `<input type="hidden" name="id" value="${esc(t.id)}"><input type="hidden" name="csrf" value="${esc(t.csrf)}">`;
    const logout = `<form method="post" action="/auth/logout"><input type="hidden" name="session_csrf" value="${esc(this.sessions.get(t.sessionId)!.csrf)}"><button>Sign out</button></form>`;
    page(
      res,
      "Connect Google Tasks",
      `<p>${esc(name)} requests read and write access to your Google Tasks.</p><p>Application names are supplied by the requesting client.</p><p>Client: ${esc(t.client.client_id)}</p><p>Callback: ${esc(t.params.redirectUri)}</p><p>Permission: ${esc(GOOGLE_TASKS_SCOPE)}</p><form method="post" action="/auth/approve">${fields}<button>Allow this client</button></form><form method="post" action="/auth/deny">${fields}<button>Deny</button></form>${logout}`,
    );
  }
  private startGoogle(
    t: Transaction,
    purpose: "identity" | "tasks",
    res: Response,
  ): void {
    t.stage = "google";
    t.purpose = purpose;
    t.state = randomToken();
    t.nonce = randomToken();
    res.redirect(
      this.google.url(
        purpose,
        t.state,
        t.nonce,
        new URL("/oauth/google/callback", this.c.baseUrl).href,
      ),
    );
  }
  install(app: Express): void {
    const parse = express.urlencoded({ extended: false, limit: "8kb" });
    const guarded =
      (fn: (req: Request, res: Response) => void | Promise<void>) =>
      (req: Request, res: Response) => {
        void Promise.resolve()
          .then(() => fn(req, res))
          .catch((error: unknown) => {
            // Only log fixed internal categories: upstream errors can contain
            // codes, tokens, client secrets, or request URLs.
            const safeReasons = new Set([
              "Invalid transaction", "Invalid CSRF", "Invalid transition",
              "Owner login required", "Invalid logout", "Invalid Google callback",
              "Google callback session missing", "Google token exchange failed",
              "Google identity verification failed", "Invalid owner",
              "Tasks consent incomplete",
            ]);
            const reason = error instanceof Error && safeReasons.has(error.message)
              ? error.message : "Authorization state update failed";
            console.error(`[authorization] ${reason}`);
            if (!res.headersSent)
              page(
                res.status(400),
                "Authorization failed",
                "<p>Restart authorization from your MCP client.</p>",
              );
          });
      };
    const transaction = (req: Request): Transaction => {
      const id =
        typeof req.body?.id === "string"
          ? req.body.id
          : typeof req.query.id === "string"
            ? req.query.id
            : "";
      const t = this.transactions.get(id),
        s = this.session(req);
      if (!t || !s || t.sessionId !== s.id || !this.valid(t))
        throw new Error("Invalid transaction");
      if (
        req.method === "POST" &&
        (typeof req.body.csrf !== "string" || !equal(req.body.csrf, t.csrf))
      )
        throw new Error("Invalid CSRF");
      return t;
    };
    app.get(
      "/auth/consent",
      guarded((req, res) => {
        const t = transaction(req);
        if (t.stage !== "owner" || this.session(req)?.owner !== this.store.snapshot().owner)
          throw new Error("Invalid transition");
        this.show(t, res);
      }),
    );
    app.post(
      "/auth/approve",
      parse,
      guarded((req, res) => {
        const t = transaction(req);
        if (
          t.stage !== "owner" ||
          this.sessions.get(t.sessionId)?.owner !== this.store.snapshot().owner
        )
          throw new Error("Owner login required");
        t.csrf = randomToken();
        if (this.store.readGoogleTokens()) {
          this.store.approve(
            t.client.client_id,
            redirectIdentity(t.params.redirectUri),
            t.resource,
          );
          this.complete(t, res);
        } else this.startGoogle(t, "tasks", res);
      }),
    );
    app.post(
      "/auth/deny",
      parse,
      guarded((req, res) => {
        const t = transaction(req);
        this.transactions.delete(t.id);
        res.redirect(this.clientRedirect(t, { error: "access_denied" }));
      }),
    );
    app.post(
      "/auth/logout",
      parse,
      guarded((req, res) => {
        const s = this.session(req);
        if (
          !s ||
          typeof req.body.session_csrf !== "string" ||
          !equal(s.csrf, req.body.session_csrf)
        )
          throw new Error("Invalid logout");
        this.sessions.delete(s.id);
        this.prune();
        res.clearCookie(this.cookieName, this.cookieOptions());
        page(
          res,
          "Signed out",
          "<p>Browser authorization was cancelled. Existing MCP grants remain active.</p>",
        );
      }),
    );
    app.get(
      "/oauth/google/callback",
      guarded(async (req, res) => {
        const state =
          typeof req.query.state === "string" ? req.query.state : "";
        const t = [...this.transactions.values()].find(
          (t) => t.state === state && t.stage === "google",
        );
        const s = this.session(req);
        if (!s) throw new Error("Google callback session missing");
        if (!state || !t || !s || s.id !== t.sessionId || !this.valid(t))
          throw new Error("Invalid Google callback");
        t.state = undefined;
        t.stage = "exchange";
        if (req.query.error && req.query.code) {
          this.transactions.delete(t.id);
          throw new Error("Invalid Google callback");
        }
        if (req.query.error || typeof req.query.code !== "string") {
          this.transactions.delete(t.id);
          res.redirect(this.clientRedirect(t, { error: "access_denied" }));
          return;
        }
        let tokens: Awaited<ReturnType<GooglePort["exchange"]>>;
        try {
          tokens = await this.google.exchange(
            req.query.code,
            new URL("/oauth/google/callback", this.c.baseUrl).href,
          );
        } catch {
          throw new Error("Google token exchange failed");
        }
        let identity: Awaited<ReturnType<GooglePort["identity"]>>;
        try {
          identity = await this.google.identity(tokens, t.nonce!);
        } catch {
          throw new Error("Google identity verification failed");
        }
        if (!this.valid(t) || identity.sub !== this.store.snapshot().owner)
          throw new Error("Invalid owner");
        if (t.purpose === "identity") {
          s.owner = identity.sub;
          s.cookie = randomToken();
          this.cookie(res, s.cookie);
          t.stage = "owner";
          t.csrf = randomToken();
          this.show(t, res);
        } else {
          if (
            s.owner !== identity.sub ||
            !tokens.refresh_token ||
            !tokens.scope?.split(" ").includes(GOOGLE_TASKS_SCOPE)
          )
            throw new Error("Tasks consent incomplete");
          this.store.provision(
            identity.sub,
            tokens,
            t.revision,
            t.client.client_id,
            {
              redirect: redirectIdentity(t.params.redirectUri),
              resource: t.resource,
            },
          );
          t.revision = this.store.revision(t.client.client_id);
          this.complete(t, res);
        }
      }),
    );
  }
}

import { google, type Auth } from "googleapis";
import { config, GOOGLE_TASKS_SCOPE, type Configuration } from "../config.js";
import { equal } from "./policy.js";

export interface Identity {
  sub: string;
  email?: string;
}
export interface GooglePort {
  url(
    purpose: "identity" | "tasks",
    state: string,
    nonce: string,
    callback: string,
  ): string;
  exchange(code: string, callback: string): Promise<Auth.Credentials>;
  identity(tokens: Auth.Credentials, nonce: string): Promise<Identity>;
}
export function googlePort(
  c: Configuration = config,
  now: () => number = Date.now,
): GooglePort {
  const client = (callback?: string) =>
    new google.auth.OAuth2(c.googleClientId, c.googleClientSecret, callback);
  return {
    url(purpose, state, nonce, callback) {
      return client(callback).generateAuthUrl({
        scope:
          purpose === "tasks"
            ? ["openid", "email", GOOGLE_TASKS_SCOPE]
            : ["openid", "email"],
        state,
        nonce,
        access_type: purpose === "tasks" ? "offline" : "online",
        ...(purpose === "tasks" ? { prompt: "consent" } : {}),
      });
    },
    async exchange(code, callback) {
      return (await client(callback).getToken(code)).tokens;
    },
    async identity(tokens, nonce) {
      if (!tokens.id_token)
        throw new Error("Google did not return an ID token");
      const ticket = await client().verifyIdToken({
        idToken: tokens.id_token,
        audience: c.googleClientId,
      });
      const payload = ticket.getPayload() as
        | (Auth.TokenPayload & { nonce?: string })
        | undefined;
      if (
        !payload?.sub ||
        !payload.nonce ||
        !equal(payload.nonce, nonce) ||
        payload.exp <= Math.floor(now() / 1000)
      )
        throw new Error("Invalid Google identity");
      return { sub: payload.sub, email: payload.email };
    },
  };
}

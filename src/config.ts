import { isIP } from "node:net";
import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

dotenv.config();
export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const MCP_SCOPE = "tasks";
export interface Configuration {
  port: number;
  host: string;
  baseUrl: string;
  mode: "local" | "hosted";
  googleClientId: string;
  googleClientSecret: string;
  ownerSub: string;
  dataDir: string;
  setupUrl: string;
  trustedProxies: string[];
  browserOrigins: string[];
}
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Configuration {
  const port = Number(env.PORT ?? "3789");
  const mode = env.DEPLOYMENT_MODE ?? "local";
  if (mode !== "local" && mode !== "hosted")
    throw new Error("DEPLOYMENT_MODE must be local or hosted");
  return {
    port,
    mode,
    host: env.HOST ?? "127.0.0.1",
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    ownerSub: env.OWNER_GOOGLE_SUB ?? "",
    dataDir: env.DATA_DIR ?? path.join(os.homedir(), ".g-tasks-mcp"),
    setupUrl: env.SETUP_URL ?? `http://localhost:${port}/oauth/google/callback`,
    trustedProxies: (env.TRUST_PROXY ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    browserOrigins: (env.BROWSER_ORIGINS ?? "").split(",").filter(Boolean),
  };
}
export const config = loadConfig();
export const issuerFor = (c: Configuration): string => new URL(c.baseUrl).href;
export const resourceFor = (c: Configuration): string =>
  new URL("/mcp", c.baseUrl).href;
export function assertConfig(c: Configuration = config): void {
  if (!c.googleClientId || !c.googleClientSecret)
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw new Error("Invalid PORT");
  const url = new URL(c.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("BASE_URL must be an origin");
  if (c.mode === "hosted" && url.protocol !== "https:")
    throw new Error("Hosted BASE_URL requires HTTPS");
  if (c.mode === "hosted" && !c.trustedProxies.length)
    throw new Error(
      "Hosted mode requires explicit TRUST_PROXY IPs/subnets for its HTTPS reverse proxy",
    );
  if (
    c.trustedProxies.some((value) => {
      const [ip, bits, extra] = value.split("/");
      const family = isIP(ip);
      return (
        !family ||
        extra !== undefined ||
        (bits !== undefined &&
          (!/^[1-9][0-9]*$/.test(bits) ||
            Number(bits) > (family === 4 ? 32 : 128)))
      );
    })
  )
    throw new Error(
      "TRUST_PROXY must contain explicit IPs or valid IP subnets",
    );
  if (
    c.mode === "local" &&
    (!["localhost", "127.0.0.1"].includes(url.hostname) ||
      c.host !== "127.0.0.1" ||
      !["http:", "https:"].includes(url.protocol))
  )
    throw new Error("Local mode requires a loopback URL and HOST=127.0.0.1");
  const setup = new URL(c.setupUrl);
  if (
    setup.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(setup.hostname) ||
    setup.pathname !== "/oauth/google/callback" ||
    setup.search ||
    setup.hash ||
    setup.username ||
    setup.password
  )
    throw new Error("SETUP_URL must be a registered loopback HTTP callback");
  for (const origin of c.browserOrigins)
    if (new URL(origin).origin !== origin)
      throw new Error("BROWSER_ORIGINS must contain origins");
}

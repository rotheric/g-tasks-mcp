import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { google } from "googleapis";
import { googlePort } from "../src/auth/google-identity.js";
import { loadConfig } from "../src/config.js";

const c = loadConfig({
  GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake",
});
test("Google verifier validates signed fixtures; app also checks exact expiry and nonce", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    now = Math.floor(Date.now() / 1000);
  const proto = google.auth.OAuth2.prototype,
    original = proto.getFederatedSignonCertsAsync;
  proto.getFederatedSignonCertsAsync = async () => ({
    certs: {
      fixture: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
    format: "PEM" as never,
  });
  function jwt(patch: Record<string, unknown> = {}) {
    const head = Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "fixture" }),
      ).toString("base64url"),
      body = Buffer.from(
        JSON.stringify({
          iss: "https://accounts.google.com",
          aud: c.googleClientId,
          iat: now,
          exp: now + 3600,
          sub: "owner",
          nonce: "nonce",
          ...patch,
        }),
      ).toString("base64url");
    return (
      head +
      "." +
      body +
      "." +
      createSign("RSA-SHA256")
        .update(head + "." + body)
        .sign(keys.privateKey, "base64url")
    );
  }
  try {
    const port = googlePort(c, () => now * 1000);
    assert.equal(
      (await port.identity({ id_token: jwt() }, "nonce")).sub,
      "owner",
    );
    for (const patch of [
      { aud: "other" },
      { iss: "https://evil.example" },
      { exp: now },
      { nonce: "wrong" },
      { nonce: undefined },
      { sub: "" },
    ])
      await assert.rejects(() =>
        port.identity({ id_token: jwt(patch) }, "nonce"),
      );
    const good = jwt();
    await assert.rejects(() =>
      port.identity({ id_token: good.slice(0, -10) + "abcdefghij" }, "nonce"),
    );
  } finally {
    proto.getFederatedSignonCertsAsync = original;
  }
});

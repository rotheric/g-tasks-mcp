import express from "express";
import { equal, randomToken } from "./policy.js";
import type { Configuration } from "../config.js";
import type { GooglePort, Identity } from "./google-identity.js";

export function createSetupBrowser(
  c: Configuration,
  google: GooglePort,
  now: () => number = Date.now,
) {
  const app = express(),
    url = new URL(c.setupUrl),
    entry = randomToken(),
    state = randomToken(),
    nonce = randomToken(),
    cookie = randomToken();
  const expiry = now() + 10 * 60 * 1000;
  let started = false,
    consumed = false;
  let finish!: (identity: Identity) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<Identity>((resolve, reject) => {
    finish = resolve;
    fail = (error) => {
      consumed = true;
      reject(error);
    };
  });
  app.use((req, res, next) => {
    if (req.headers.host !== url.host) {
      res.sendStatus(421);
      return;
    }
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.get("/setup", (req, res) => {
    if (
      started ||
      now() >= expiry ||
      typeof req.query.key !== "string" ||
      !equal(req.query.key, entry)
    ) {
      res.sendStatus(400);
      return;
    }
    started = true;
    res.cookie("gtasks-setup", cookie, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.redirect(google.url("identity", state, nonce, c.setupUrl));
  });
  app.get("/oauth/google/callback", (req, res) => {
    void (async () => {
      if (
        !started ||
        consumed ||
        now() >= expiry ||
        typeof req.query.state !== "string" ||
        !equal(req.query.state, state) ||
        !(req.headers.cookie ?? "")
          .split(";")
          .some((s) => s.trim() === "gtasks-setup=" + cookie)
      )
        throw new Error("Invalid setup callback");
      consumed = true;
      if (typeof req.query.code !== "string" || req.query.error)
        throw new Error("Invalid setup response");
      const identity = await google.identity(
        await google.exchange(req.query.code, c.setupUrl),
        nonce,
      );
      if (now() >= expiry) throw new Error("Setup expired");
      res
        .type("text")
        .send("Return to your terminal to confirm this Google account.");
      finish(identity);
    })().catch(() => {
      res
        .status(400)
        .type("text")
        .send("Setup failed. Restart setup from the terminal.");
      fail(new Error("Google setup failed"));
    });
  });
  return { app, entry, result, fail };
}

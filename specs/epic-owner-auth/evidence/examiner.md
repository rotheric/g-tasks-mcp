# Independent verification examination

## Final bounded recheck — round 5

**Accepted offline evidence: all 19 frozen questions are YES. EX-1 is resolved.** The initial finding below is historical and superseded by this recheck; `examiner-round-1.json` preserves the initial question answers.

Inspected the correction: `Storage.verifySecret` now checks the stored secret expiration is strictly greater than the injected store clock, before hash comparison. The shared token/revocation middleware uses that predicate. Independently reran the unchanged exact-expiry reproduction plus confidential revoke and past-expiry probes: **3 passed, 0 failed**. Independently ran the new permanent exact-boundary regression: **1 passed, 0 failed**. It proves pre-expiry success, code/refresh/revoke rejection at expiry, unchanged durable state and invalid secret after reload.

```sh
NODE_OPTIONS='--require=/tmp/gtasks-examiner-0xw0r569/no-dotenv.cjs' node --import tsx --test --test-name-pattern='confidential secret|confidential revocation' /tmp/gtasks-examiner-0xw0r569/probe.ts
NODE_OPTIONS='--require=/tmp/gtasks-examiner-0xw0r569/no-dotenv.cjs' node --import tsx --test --test-name-pattern='confidential secrets expire' test/smoke.test.ts
```

The original independent 83-test/typecheck/build evidence remains recorded. The lead reports the corrected 84-test suite/typecheck/build passing; this examiner did not rerun the full suite during the bounded recheck. No additional production defect or unresolved offline question remains. MV-1 and every MV-2 live subpath remain pending and unwaived; this is not full release completion.

## Initial examination (superseded for EX-1)

Current verdict: **changes required, EX-1 (severity 2/10)**. Fifteen questions are YES; four lifecycle/checklist questions are PARTIAL. The evidence establishes the offline implementation except for the exact confidential-secret expiry boundary. It does not close real Google, host, browser or harness gates.

Independently executed 83 permanent tests, source/test typecheck and build successfully. Nineteen bounded private behavioral cases also passed. A twentieth focused probe then showed `/token` accepts a confidential secret at its exact expiration second (HTTP 200 instead of 400). The SDK checks `< now`, and the application verifies the secret hash without checking expiry itself. Reject `now >= expiry` in the shared application client-authentication boundary; preserve public clients and zero/absent expiry schema policy. A later independent recheck may supersede this finding.

Private probes use the existing HTTP fixture copied from test/smoke.test.ts with absolute imports and expose the already-injected synthetic Google port. They test actual production composition. Twelve cases retain the actual OAuth2Client request/refresh/event machinery and fake only its upstream transporter; success preserves the Google refresh token, current 400 invalid_grant disconnects durably, current transient failure preserves state, and obsolete outcomes cannot change newer/disconnected state. The initial synthetic error response omitted the library-required response.config field; that probe defect was corrected before the reported 19-pass run. A private-test syntax typo was also corrected before execution; neither was a production finding.

All original and pending manual requirements were read. A private test proves the current snapshot, not real Google consent/cookies or proprietary harness interoperability. MV-1 and each MV-2 subpath remain pending and unwaived.

Commands (repository working directory):

```sh
NODE_OPTIONS='--require=/tmp/gtasks-examiner-0xw0r569/no-dotenv.cjs' npm test
npm run typecheck && npm run build
NODE_OPTIONS='--require=/tmp/gtasks-examiner-0xw0r569/no-dotenv.cjs' node --import tsx --test /tmp/gtasks-examiner-0xw0r569/probe.ts
NODE_OPTIONS='--require=/tmp/gtasks-examiner-0xw0r569/no-dotenv.cjs' node --import tsx --test --test-name-pattern='exact expiry second' /tmp/gtasks-examiner-0xw0r569/probe.ts
```

Preload source, stored at `/tmp/gtasks-examiner-0xw0r569/no-dotenv.cjs`:

```js
const dotenv = require(process.cwd() + '/node_modules/dotenv');
dotenv.config = () => ({ parsed: {} });
```

The complete private probe source follows so it remains reproducible when `/tmp` is removed. Extract the TypeScript block to a temporary file, replace its absolute repository import prefix if moving the checkout, then run with the preload above. The final exact-expiry test failed on the initial source and passes on the corrected round-5 source. Fingerprints and per-question evidence are in examiner.json.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "/Users/mrother/Projects/rotheric/g-tasks-mcp/src/app.js";
import { getAuthorizedGoogleClient } from "/Users/mrother/Projects/rotheric/g-tasks-mcp/src/google.js";
import { Storage } from "/Users/mrother/Projects/rotheric/g-tasks-mcp/src/storage.js";
import {
  loadConfig,
  resourceFor,
  issuerFor,
  GOOGLE_TASKS_SCOPE,
} from "/Users/mrother/Projects/rotheric/g-tasks-mcp/src/config.js";
import type { GooglePort } from "/Users/mrother/Projects/rotheric/g-tasks-mcp/src/auth/google-identity.js";
import type { Auth } from "googleapis";

const verifier = "A".repeat(43),
  challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:9999/callback";
async function fixture(
  seed = true,
  productionTools = false,
  extraConfig: Record<string, string> = {},
  forwardHttps = false,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-auth-"));
  let time = Date.now();
  const store = new Storage(dir, { now: () => time });
  store.acquire();
  store.pinOwner("owner");
  const c = loadConfig({
    GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fake",
    PORT: "3789",
    DATA_DIR: dir,
    ...extraConfig,
  });
  if (seed)
    store.provision(
      "owner",
      { access_token: "google-access", refresh_token: "google-refresh" },
      store.revision("initial"),
      "initial",
    );
  let nonce = "",
    purpose = "identity",
    sub = "owner";
  let pause: Promise<void> | undefined;
  let outcome = "success";
  const googleTransactions = new Map<
    string,
    { nonce: string; purpose: string }
  >();
  let release: () => void = () => {};
  let notify: () => void = () => {};
  let entered = Promise.resolve();
  const google: GooglePort = {
    url(p, s, n, callback) {
      nonce = n;
      purpose = p;
      googleTransactions.set(s, { nonce: n, purpose: p });
      const u = new URL("https://accounts.google.com/auth");
      u.searchParams.set("state", s);
      u.searchParams.set("nonce", n);
      u.searchParams.set("redirect_uri", callback);
      u.searchParams.set("purpose", p);
      return u.href;
    },
    async exchange(code) {
      const transaction = googleTransactions.get(code);
      const pending = pause,
        capturedNonce = transaction?.nonce ?? nonce,
        capturedPurpose = transaction?.purpose ?? purpose,
        capturedOutcome = outcome;
      if (pending) {
        notify();
        await pending;
      }
      if (capturedOutcome !== "success") throw new Error(capturedOutcome);
      return {
        id_token: capturedNonce,
        refresh_token:
          capturedPurpose === "tasks" ? "new-google-refresh" : undefined,
        scope: capturedPurpose === "tasks" ? GOOGLE_TASKS_SCOPE : undefined,
      };
    },
    async identity(t, n) {
      assert.equal(t.id_token, n);
      return { sub };
    },
  };
  let effects = 0;
  const buildApp = () =>
    createApp({
      store,
      configuration: c,
      google,
      now: () => time,
      ...(productionTools
        ? {}
        : {
            tools(
              server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
            ) {
              server.registerTool(
                "create_task",
                { description: "test external Tasks port", inputSchema: {} },
                async () => {
                  effects++;
                  return { content: [{ type: "text", text: "created" }] };
                },
              );
            },
          }),
    });
  let server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  async function request(url: string, init: RequestInit = {}) {
    const res = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        new URL(url, base),
        {
          method: init.method ?? "GET",
          headers: {
            host: "localhost:3789",
            ...(forwardHttps ? { "x-forwarded-proto": "https" } : {}),
            ...(cookie ? { cookie } : {}),
            ...Object.fromEntries(new Headers(init.headers)),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (b) => chunks.push(b));
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(incoming.headers))
              if (v !== undefined)
                headers.set(k, Array.isArray(v) ? v.join(",") : v);
            resolve(
              new Response(
                incoming.statusCode === 204 ? null : Buffer.concat(chunks),
                { status: incoming.statusCode, headers },
              ),
            );
          });
        },
      );
      req.on("error", reject);
      if (init.body) req.write(String(init.body));
      req.end();
    });
    const next = res.headers.get("set-cookie");
    if (next) cookie = next.split(";")[0];
    return res;
  }
  async function register(method = "none") {
    const res = await request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test client",
        redirect_uris: [redirect],
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(res.status, 201);
    return await res.json();
  }
  function fields(html: string) {
    return {
      id: html.match(/name="id" value="([^"]+)"/)![1],
      csrf: html.match(/name="csrf" value="([^"]+)"/)![1],
      session_csrf: html.match(/name="session_csrf" value="([^"]+)"/)![1],
    };
  }
  const post = (url: string, body: Record<string, string | undefined>) =>
    request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(
        Object.entries(body).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
  async function begin(clientId: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
      resource: resourceFor(c),
      ...extra,
    });
    return request("/authorize?" + q);
  }
  async function identityLogin(clientId: string, first?: Response) {
    first ??= await begin(clientId);
    assert.equal(first.status, 302);
    assert.ok(first.headers.get("location")!.startsWith("/auth/consent"));
    let html = await (await request(first.headers.get("location")!)).text();
    let f = fields(html);
    const login = await post("/auth/continue", f);
    assert.equal(login.status, 302);
    const g = new URL(login.headers.get("location")!);
    assert.equal(g.searchParams.get("purpose"), "identity");
    html = await (
      await request(
        "/oauth/google/callback?" +
          new URLSearchParams({
            state: g.searchParams.get("state")!,
            code: "fake-code",
          }),
      )
    ).text();
    f = fields(html);
    return f;
  }
  async function authorize(clientId: string) {
    const first = await begin(clientId);
    const location = first.headers.get("location")!;
    if (location.startsWith(redirect))
      return new URL(location).searchParams.get("code")!;
    const f = await identityLogin(clientId, first);
    let res = await post("/auth/approve", f);
    if (
      res.headers.get("location")?.startsWith("https://accounts.google.com")
    ) {
      const g = new URL(res.headers.get("location")!);
      res = await request(
        "/oauth/google/callback?" +
          new URLSearchParams({
            state: g.searchParams.get("state")!,
            code: "fake-tasks",
          }),
      );
    }
    assert.equal(res.status, 302);
    const u = new URL(res.headers.get("location")!);
    assert.equal(u.searchParams.get("iss"), issuerFor(c));
    assert.equal(u.searchParams.get("state"), "client-state");
    assert.ok(u.searchParams.get("code"));
    return u.searchParams.get("code")!;
  }
  const token = (clientId: string, code: string, secret?: string) =>
    post("/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: resourceFor(c),
      ...(secret ? { client_secret: secret } : {}),
    });
  return {
    google,
    store,
    c,
    dir,
    request,
    register,
    post,
    begin,
    fields,
    identityLogin,
    authorize,
    token,
    effects: () => effects,
    clearCookie: () => {
      cookie = "";
    },
    wrongOwner: () => {
      sub = "intruder";
    },
    advance: (n: number) => {
      time += n;
    },
    suspend: () => {
      entered = new Promise<void>((r) => (notify = r));
      pause = new Promise<void>((r) => (release = r));
    },
    waitExchange: () => entered,
    resume: () => release(),
    unpauseNew: () => {
      pause = undefined;
      outcome = "success";
    },
    outcome: (value: string) => {
      outcome = value;
    },
    restart: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.release();
      store.acquire();
      server = buildApp().listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => {
      server.close();
      server.closeAllConnections();
      store.release();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}


test("examiner: simultaneous identity callbacks preserve both transactions across cookie rotation", async () => {
 const f=await fixture();
 try {
  const a=await f.register(), b=await f.register();
  async function start(id:string) { const r=await f.begin(id); const fields=f.fields(await (await f.request(r.headers.get("location")!)).text()); return new URL((await f.post("/auth/continue",fields)).headers.get("location")!); }
  const ga=await start(a.client_id), gb=await start(b.client_id);
  const callback=(u:URL)=>"/oauth/google/callback?"+new URLSearchParams({state:u.searchParams.get("state")!,code:u.searchParams.get("state")!});
  f.suspend(); const pa=f.request(callback(ga)); await f.waitExchange(); f.unpauseNew();
  const rb=await f.request(callback(gb)); f.resume(); const ra=await pa;
  assert.equal(ra.status,200); assert.equal(rb.status,200);
  for (const [id,r] of [[a.client_id,ra],[b.client_id,rb]] as const) {
   const approval=await f.post("/auth/approve",f.fields(await r.text()));
   assert.equal(approval.status,302); const code=new URL(approval.headers.get("location")!).searchParams.get("code")!;
   assert.equal((await f.token(id,code)).status,200);
  }
 } finally {f.resume();f.close();}
});
test("examiner: changed callback requires consent and denial issues no grant; production tools stay registered", async()=>{
 const f=await fixture(true,true);
 try {
  const client=await f.register(); const code=await f.authorize(client.client_id); const tokens=await(await f.token(client.client_id,code)).json();
  const current=f.store.getClient(client.client_id)!; f.store.saveClient({...current,redirect_uris:[redirect,"http://127.0.0.1:9999/changed"]});
  const start=await f.begin(client.client_id,{redirect_uri:"http://127.0.0.1:9999/changed"});
  assert.match(start.headers.get("location")!,/^\/auth\/consent/);
  const fields=f.fields(await(await f.request(start.headers.get("location")!)).text());
  const denial=await f.post("/auth/deny",fields); const u=new URL(denial.headers.get("location")!);
  assert.equal(u.searchParams.get("error"),"access_denied"); assert.equal(u.searchParams.get("code"),null); assert.equal(u.searchParams.get("state"),"client-state"); assert.equal(u.searchParams.get("iss"),issuerFor(f.c));
  const res=await f.request("/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+tokens.access_token},body:JSON.stringify({jsonrpc:"2.0",id:4,method:"tools/list"})});
  const text=await res.text(); for(const name of ["list_task_lists","create_task_list","delete_task_list","list_tasks","get_task","create_task","update_task","complete_task","delete_task","move_task","clear_completed_tasks"]) assert.ok(text.includes('"name":"'+name+'"'),name);
 } finally {f.close();}
});
test("examiner: confidential revocation rejects missing/verifier secrets and accepts plaintext",async()=>{
 const f=await fixture(); try{
  const c=await f.register("client_secret_post"),code=await f.authorize(c.client_id),t=await(await f.token(c.client_id,code,c.client_secret)).json();
  for(const secret of [undefined,f.store.getClient(c.client_id)!.client_secret]) {assert.equal((await f.post("/revoke",{client_id:c.client_id,client_secret:secret,token:t.refresh_token})).status,400); assert.ok(f.store.accessToken(t.access_token,resourceFor(f.c)));}
  assert.equal((await f.post("/revoke",{client_id:c.client_id,client_secret:c.client_secret,token:t.refresh_token})).status,200); assert.equal(f.store.accessToken(t.access_token,resourceFor(f.c)),undefined);
 }finally{f.close();}
});
test("examiner: production provisioning rejects wrong owner, missing scope and missing refresh",async()=>{
 for(const variant of ["owner","scope","refresh"]){ const f=await fixture(false);try{
  const c=await f.register(), fields=await f.identityLogin(c.client_id), r=await f.post("/auth/approve",fields),u=new URL(r.headers.get("location")!);
  const before=f.store.snapshot(); const exchange=f.google.exchange;
  f.google.exchange=async(code,callback)=>{const t=await exchange(code,callback);if(variant==="scope")t.scope="openid email";if(variant==="refresh")delete t.refresh_token;return t;};
  if(variant==="owner")f.wrongOwner();
  const res=await f.request("/oauth/google/callback?"+new URLSearchParams({state:u.searchParams.get("state")!,code:"fake"}));assert.equal(res.status,400);assert.deepEqual(f.store.snapshot(),before);
 }finally{f.close();}}
});
for(const event of ["current","disconnect","reconnect","credential-revision"])for(const outcome of ["success","invalid_grant","transient"])
test(`examiner real Google refresh producer ${outcome} after ${event}`,async()=>{
 const f=await fixture(true,true);try{
  const c=await f.register();f.store.provision("owner",{refresh_token:"upstream-refresh",access_token:"expired",expiry_date:1},f.store.revision(c.client_id),c.client_id);
  const t=await(await f.token(c.client_id,await f.authorize(c.client_id))).json();
  const google=getAuthorizedGoogleClient(f.store,f.c);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),paused=new Promise<void>(r=>release=r);
  let refreshRequests=0,taskRequests=0;
  google.transporter.request=(async(options:any)=>{
    if(String(options.url).includes("oauth2.googleapis.com/token")){
     refreshRequests++; assert.match(String(options.data),/grant_type=refresh_token/); enter();await paused;
     if(outcome!=="success"){const error=Object.assign(new Error(outcome==="invalid_grant"?"invalid_grant":"temporary"),{response:{status:outcome==="invalid_grant"?400:503,data:{error:outcome},config:options}});throw error;}
     return {data:{access_token:"actual-refresh-result",expires_in:3600,token_type:"Bearer"}};
    }
    taskRequests++;return {data:{id:"actual-refresh-task",title:"Task"}};
  }) as typeof google.transporter.request;
  const pending=f.request("/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+t.access_token},body:JSON.stringify({jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"create_task",arguments:{title:"Task"}}})});
  await entered;
  if(event==="disconnect"||event==="reconnect")f.store.clearGoogleTokens();
  if(event==="reconnect"||event==="credential-revision")f.store.provision("owner",{refresh_token:"replacement"},f.store.revision(c.client_id),c.client_id);
  const committed=f.store.snapshot();release();assert.equal((await pending).status,200);assert.equal(refreshRequests,1);assert.equal(taskRequests,outcome==="success"?1:0);
  if(event!=="current"||outcome==="transient")assert.deepEqual(f.store.snapshot(),committed);
  else if(outcome==="invalid_grant"){assert.equal(f.store.readGoogleTokens(),null);assert.equal(f.store.accessToken(t.access_token,resourceFor(f.c)),undefined);}
  else {assert.equal(f.store.readGoogleTokens()!.access_token,"actual-refresh-result");assert.equal(f.store.readGoogleTokens()!.refresh_token,"upstream-refresh");}
  const final=f.store.snapshot();f.store.release();f.store.acquire();assert.deepEqual(f.store.snapshot(),final);
 }finally{f.close();}
});
test("examiner: refresh concurrency fails closed and exact family expiry caps bearer TTL",async()=>{
 for(const variant of ["parallel","family"]){const f=await fixture();try{
  const c=await f.register(),t=await(await f.token(c.client_id,await f.authorize(c.client_id))).json();
  const refresh=()=>f.post("/token",{grant_type:"refresh_token",client_id:c.client_id,refresh_token:t.refresh_token});
  if(variant==="parallel"){
   const results=await Promise.all([refresh(),refresh()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
   const success=await results.find(r=>r.status===200)!.json();assert.equal(f.store.accessToken(success.access_token,resourceFor(f.c)),undefined);
   assert.equal((await f.post("/token",{grant_type:"refresh_token",client_id:c.client_id,refresh_token:success.refresh_token})).status,400);
  }else{
   f.advance((90*86400-1)*1000);const r=await refresh();assert.equal(r.status,200);const next=await r.json();assert.equal(next.expires_in,1);assert.ok(f.store.accessToken(next.access_token,resourceFor(f.c)));
   f.advance(1000);assert.equal(f.store.accessToken(next.access_token,resourceFor(f.c)),undefined);assert.equal((await f.post("/token",{grant_type:"refresh_token",client_id:c.client_id,refresh_token:next.refresh_token})).status,400);
  }
 }finally{f.close();}}
});
test("examiner: live runtime state rejects absent and mismatched cookies without consuming the owner flow",async()=>{
 const f=await fixture();try{
  const c=await f.register(),start=await f.begin(c.client_id),fields=f.fields(await(await f.request(start.headers.get("location")!)).text());
  const u=new URL((await f.post("/auth/continue",fields)).headers.get("location")!);
  const url="/oauth/google/callback?"+new URLSearchParams({state:u.searchParams.get("state")!,code:u.searchParams.get("state")!});
  const before=f.store.snapshot();for(const cookie of ["","gtasks-local=wrong-session"]){assert.equal((await f.request(url,{headers:{cookie}})).status,400);assert.deepEqual(f.store.snapshot(),before);}
  assert.equal((await f.request(url)).status,200);
 }finally{f.close();}
});
test("examiner: expired confidential secret denies token, refresh and revoke without mutations",async()=>{
 const f=await fixture();try{
  const c=await f.register("client_secret_post"),t=await(await f.token(c.client_id,await f.authorize(c.client_id),c.client_secret)).json();
  const code=await f.authorize(c.client_id);
  f.store.update(s=>{s.clients[c.client_id].client_secret_expires_at=Math.floor(Date.now()/1000)-1;});const before=f.store.snapshot();
  assert.equal((await f.token(c.client_id,code,c.client_secret)).status,400);
  assert.equal((await f.post("/token",{grant_type:"refresh_token",client_id:c.client_id,client_secret:c.client_secret,refresh_token:t.refresh_token})).status,400);
  assert.equal((await f.post("/revoke",{client_id:c.client_id,client_secret:c.client_secret,token:t.refresh_token})).status,400);assert.deepEqual(f.store.snapshot(),before);
 }finally{f.close();}
});
test("examiner: confidential secret rejects at its exact expiry second",async()=>{
 const f=await fixture();const originalNow=Date.now;try{
  const c=await f.register("client_secret_post"), code=await f.authorize(c.client_id);
  const expiry=Math.floor(originalNow()/1000); Date.now=()=>expiry*1000;
  f.store.update(s=>{s.clients[c.client_id].client_secret_expires_at=expiry;});
  assert.equal((await f.token(c.client_id,code,c.client_secret)).status,400);
 }finally{Date.now=originalNow;f.close();}
});

```

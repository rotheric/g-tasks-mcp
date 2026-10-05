import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {chromium} = await import(process.argv[3]);
const compiled = process.argv[2];
const {createApp} = await import(`${compiled}/src/app.js`);
const {Storage} = await import(`${compiled}/src/storage.js`);
const {loadConfig} = await import(`${compiled}/src/config.js`);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtasks-browser-state-'));
const store=new Storage(dir);store.acquire();store.pinOwner('synthetic-owner');
store.provision('synthetic-owner',{refresh_token:'synthetic-refresh'},store.revision('initial'),'initial');
const c=loadConfig({GOOGLE_CLIENT_ID:'synthetic',GOOGLE_CLIENT_SECRET:'synthetic',PORT:'37890',DATA_DIR:dir});
let nonce,googleState;
const google={url(p,state,n){nonce=n;googleState=state;return 'https://accounts.google.com/mock?state='+state},async exchange(){return {id_token:nonce}},async identity(tokens,n){assert.equal(tokens.id_token,n);return {sub:'synthetic-owner'}}};
const server=createApp({store,configuration:c,google}).listen(37890,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({headless:true});
try {
 for(const mode of ['old-policy','corrected-policy']) {
  const context=await browser.newContext();const page=await context.newPage();let googleReached=false;
  page.on('console',message=>{if(message.text().includes('form-action'))console.log('CSP:',message.text());});
  page.on('requestfailed',request=>console.log('FAILED',new URL(request.url()).origin,request.failure()));
  page.on('response',response=>{if(new URL(response.url()).pathname==='/auth/continue')console.log('POST response',response.status(),response.headers()['content-security-policy']);});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:'https://accounts.google.com/*'},{urlPattern:'http://127.0.0.1:39991/*'}]});
  cdp.on('Fetch.requestPaused',async event=>{const external=event.request.url.startsWith('https://accounts.google.com/');if(external)googleReached=true;await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(external?'<title>Synthetic Google</title>Google reached':'<title>Client callback</title>Callback reached').toString('base64')});});
  if(mode==='old-policy')await context.route('**/auth/consent?*',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});});
  const client=await (await fetch('http://localhost:37890/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Synthetic browser check',redirect_uris:['http://127.0.0.1:39991/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})})).json();
  const params=new URLSearchParams({client_id:client.client_id,response_type:'code',redirect_uri:'http://127.0.0.1:39991/callback',code_challenge:createHash('sha256').update('A'.repeat(43)).digest('base64url'),code_challenge_method:'S256',state:'synthetic-client-state',scope:'tasks',resource:'http://localhost:37890/mcp'});
  const start=await context.request.get('http://localhost:37890/authorize?'+params,{maxRedirects:0});
  await page.goto('http://localhost:37890'+start.headers().location);
  const submitted={id:await page.locator('form').first().locator('[name=id]').inputValue(),csrf:await page.locator('form').first().locator('[name=csrf]').inputValue()};
  await page.getByRole('button',{name:'Continue to sign in'}).click();
  if(mode==='old-policy') {
   await page.waitForTimeout(250);assert.equal(googleReached,false);
   const repeated=await context.request.post('http://localhost:37890/auth/continue',{form:submitted,headers:{origin:'http://localhost:37890'}});
   assert.equal(repeated.status(),400);assert((await repeated.text()).includes('Authorization failed'));
   console.log('PASS: old policy blocks Google; repeated Continue produces Invalid CSRF');
  } else {
   await page.waitForURL('https://accounts.google.com/**');await page.waitForLoadState('domcontentloaded');console.log('Result title:',await page.title());assert.equal(googleReached,true);
   await page.goto('http://localhost:37890/oauth/google/callback?'+new URLSearchParams({state:googleState,code:'synthetic-code'}));
   await page.getByRole('button',{name:'Allow this client'}).click();
   await page.waitForURL('http://127.0.0.1:39991/**');
   console.log('PASS: corrected policy reaches Google and client callback after approval');
  }
  await context.close();
 }
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.release();fs.rmSync(dir,{recursive:true,force:true});}

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const sha=b=>createHash('sha256').update(b).digest('hex');
const assert=(ok,code)=>{if(!ok)throw Error(code);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const allowed=['index.html','impressum.html','styles.css','assets/relay-qr.png','README.md','relay-proof.json'];
const files=new Map();
for(const name of allowed){const s=await fs.lstat(name);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=200000,'invalid_demo_file');files.set(name,await fs.readFile(name));}
const proof=JSON.parse(files.get('relay-proof.json'));
assert(proof.schema==='botrelay.qualification.git.v1'&&uuid.test(proof.attemptId)&&uuid.test(proof.connectionId)&&/^[a-f0-9]{64}$/.test(proof.nonce),'invalid_demo_binding');
assert(process.env.GITHUB_REF_NAME==='qualification/'+proof.attemptId,'wrong_demo_branch');
for(const name of ['index.html','impressum.html']){
 const html=files.get(name).toString('utf8');
 assert(/<!doctype html>/i.test(html)&&/<html\b[^>]*\blang=["']de["']/i.test(html)&&/name=["']viewport["']/i.test(html)&&/<title>[^<]+<\/title>/i.test(html),'html_contract');
 assert(!/<(?:script|iframe|object|embed|base)\b|\bon[a-z]+\s*=|javascript\s*:|http-equiv\s*=|BEGIN:VCARD|text\/vcard/i.test(html),'active_content_forbidden');
 assert(html.includes('styles.css')&&html.includes('Demo'),'demo_context_required');
 assert(!/(?:src|href)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(html),'external_asset_forbidden');
}
const html=files.get('index.html').toString('utf8'),css=files.get('styles.css').toString('utf8');
assert(html.includes(proof.nonce)&&html.includes('impressum.html')&&html.includes('assets/relay-qr.png'),'handover_content_missing');
assert(/@media\b/.test(css)&&!/@import|url\(\s*["']?(?:https?:|\/\/|data:)/i.test(css),'responsive_local_css_required');
assert(files.get('README.md').toString('utf8').includes(proof.nonce),'readme_binding_missing');
const require=createRequire(path.join(process.env.RUNNER_TEMP,'relay-audit','package.json'));
const {chromium}=await import(pathToFileURL(path.join(process.env.RUNNER_TEMP,'relay-audit/node_modules/playwright-core/index.mjs')).href);
const lighthouse=(await import(pathToFileURL(require.resolve('lighthouse')).href)).default;
const {launch}=await import(pathToFileURL(require.resolve('chrome-launcher')).href);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=http.createServer((req,res)=>{const name=req.url==='/'?'index.html':req.url.slice(1);if(!files.has(name)||!['index.html','impressum.html','styles.css','assets/relay-qr.png'].includes(name)){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(name)],'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'self'; script-src 'none'; frame-src 'none'"});res.end(files.get(name));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port,evidence='.relay/evidence';
await fs.mkdir(evidence,{recursive:true});
let browser,chrome;
const metrics={};
try{
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-background-networking','--disable-extensions']});
 for(const [name,width,height]of [['mobile',390,844],['desktop',1440,1000]]){
  const context=await browser.newContext({viewport:{width,height}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();await page.goto(origin,{waitUntil:'networkidle'});
  assert(await page.locator('h1').count()===1,'one_heading_required');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal_overflow');
  await page.locator('a[href="impressum.html"]').first().click();assert(page.url()===origin+'/impressum.html','legal_link_broken');
  await page.goto(origin,{waitUntil:'networkidle'});await page.screenshot({path:evidence+'/'+name+'.png',fullPage:true});await context.close();
 }
 await browser.close();browser=null;
 chrome=await launch({chromePath:'/usr/bin/google-chrome',chromeFlags:['--headless','--no-sandbox','--disable-background-networking','--disable-extensions']});
 for(const formFactor of ['mobile','desktop']){
  const {lhr}=await lighthouse(origin,{port:chrome.port,logLevel:'error',onlyCategories:['performance','accessibility','best-practices'],formFactor,screenEmulation:{mobile:formFactor==='mobile',width:formFactor==='mobile'?390:1440,height:formFactor==='mobile'?844:1000,deviceScaleFactor:1,disabled:false}});
  assert(!lhr.runtimeError,'lighthouse_runtime_failure');
  metrics[formFactor]=Object.fromEntries(Object.entries(lhr.categories).map(([key,value])=>[key,Math.round(value.score*100)]));
  assert(metrics[formFactor].performance>=70&&metrics[formFactor].accessibility>=90&&metrics[formFactor]['best-practices']>=90,'lighthouse_threshold');
  await fs.writeFile(evidence+'/lighthouse-'+formFactor+'.json',JSON.stringify(lhr));
 }
 const artifacts=[];for(const name of [...allowed,...['mobile.png','desktop.png','lighthouse-mobile.json','lighthouse-desktop.json'].map(n=>evidence+'/'+n)]){const data=await fs.readFile(name);artifacts.push({path:name,bytes:data.length,sha256:sha(data)});}
 await fs.writeFile(evidence+'/result.json',JSON.stringify({schema:'botrelay.qualification.handover.v1',attemptId:proof.attemptId,connectionId:proof.connectionId,nonce:proof.nonce,sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,passed:true,metrics,artifacts},null,2)+'\n');
 console.log('DEMO_HANDOVER_VERIFIED');
}finally{await browser?.close();await chrome?.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

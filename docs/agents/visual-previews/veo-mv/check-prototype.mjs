import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
const require=createRequire(new URL('../../../../package.json',import.meta.url));
const {chromium}=require('playwright');
const root=fileURLToPath(new URL('.',import.meta.url));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const results={scope:'Chinese design prototype only; no model, backend, payment, real media or persistence acceptance',checks:[],views:0};
const assert=(v,m)=>{if(!v)throw Error(m);results.checks.push(m)};
try {
 const page=await browser.newPage({viewport:{width:393,height:852}});
 const errors=[],network=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith('http://127.0.0.1:4317/'))network.push(r.url())});
 await page.goto('http://127.0.0.1:4317/agents/visual-previews/veo-mv/prototype.html');
 await page.locator('[name=length][value="8"]').check();
 await page.locator('#story').click();
 assert(await page.locator('#shots textarea').count()===1,'8 seconds has one editable scene');
 await page.locator('#shots textarea').fill('合成示例：缓慢掠过安静的海面。');
 await page.locator('#edit').click();await page.locator('#story').click();
 assert((await page.locator('#shots textarea').inputValue()).includes('安静的海面'),'unedited plan survives back and return');
 await page.locator('#edit').click();await page.locator('[name=length][value="15"]').check();
 await page.locator('#description').fill('没有人物的雨夜城市');await page.locator('#story').click();
 assert(await page.locator('#shots textarea').count()===2,'15 seconds has two editable scenes');
 assert((await page.locator('#shots textarea').first().inputValue()).includes('没有人物'),'description appears in visible plan');
 await page.locator('#generate').click();assert(await page.locator('#state').inputValue()==='queued','explicit confirmation precedes queued state');
 await page.locator('#leave').click();assert(await page.locator('#away').isVisible(),'leave opens return view');
 await page.locator('#next').click();await page.locator('#return').click();
 assert(await page.locator('#state').inputValue()==='generating','return retains in-memory demo progress');
 await page.locator('#cancel').click();assert(await page.locator('#state').inputValue()==='cancelling','cancel waits for confirmation state');
 await page.locator('#next').click();assert(await page.locator('#state').inputValue()==='cancelled','only demo acknowledgement reaches cancelled');
 await page.locator('#state').selectOption('reconciling');assert(!(await page.locator('#generate').isVisible()),'unknown submission offers no new generation button');
 await page.locator('#state').selectOption('budget');await page.locator('#restart').click();await page.locator('#story').click();
 assert(await page.locator('#generate').isDisabled(),'budget denial remains visible and blocks confirmation');
 await page.locator('#state').selectOption('ready');assert(await page.locator('#ready button:disabled').count()===2,'no false download or share without media');
 const states=await page.locator('#state option').evaluateAll(es=>es.map(e=>e.value));
 for(const width of [360,393,768,1280]){
  await page.setViewportSize({width,height:900});
  for(const state of states){await page.locator('#state').selectOption(state);const failures=await page.evaluate(()=>[...document.querySelectorAll('button,textarea,select,h1,h2,h3,.panel')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>({tag:e.tagName,id:e.id,rect:e.getBoundingClientRect()})).filter(e=>e.rect.left< -1||e.rect.right>innerWidth+1).map(e=>e.tag+'#'+e.id));if(failures.length)throw Error(`${width}/${state} clipped: ${failures}`);results.views++;}
 }
 await page.emulateMedia({reducedMotion:'reduce'});assert(await page.locator('body *').evaluateAll(es=>es.every(e=>getComputedStyle(e).animationName==='none')),'reduced motion has no animation');
 for(const width of [393,1280]){await page.setViewportSize({width,height:900});for(const state of ['config','draft']){await page.locator('#state').selectOption(state);await page.screenshot({path:root+`/${state}-zh-${width}.png`,fullPage:true})}}
 await page.setViewportSize({width:393,height:900});
 const price=await page.locator('#summary-length').boundingBox(),confirm=await page.locator('#generate').boundingBox();assert(price.y<confirm.y,'mobile confirmation follows consumption summary');
 assert(errors.length===0,'no browser script errors');assert(network.length===0,'no external HTTP requests or service calls');
 results.result='pass';console.log(JSON.stringify(results,null,2));
} catch(e){results.result='fail';results.error=e.message;process.exitCode=1;console.log(JSON.stringify(results,null,2))} finally {await browser.close();writeFileSync(root+'/prototype-check.json',JSON.stringify(results,null,2)+'\n')}

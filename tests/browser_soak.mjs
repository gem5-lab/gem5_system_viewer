// Repeated demo playback, folding, and state checks against a dedicated Chrome CDP instance.
import fs from 'node:fs';
import path from 'node:path';
const viewerURL=process.env.VIEWER_URL||'http://127.0.0.1:8765';
const cdpURL=process.env.CDP_URL||'http://127.0.0.1:9231';
const tabs=await(await fetch(cdpURL+'/json')).json();
const tab=tabs.find(t=>t.type==='page'&&t.url.startsWith(viewerURL));
if(!tab)throw Error('Viewer tab not found');
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map(),errors=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
async function call(method,params={}){const n=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(n,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id:n,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
try{
await call('Runtime.enable');await call('Page.enable');
await evaluate('window.viewerReady=false');
await call('Page.navigate',{url:viewerURL+'/?qa='+Date.now()+'#tick=500&component=system.cpu.decode'});
await call('Emulation.setDeviceMetricsOverride',{width:1550,height:1100,deviceScaleFactor:1,mobile:false});
for(let i=0;i<30&&!await evaluate('window.viewerReady===true');i++)await new Promise(r=>setTimeout(r,300));
if(!await evaluate('window.viewerReady===true'))throw Error(await evaluate('document.body.innerText'));

const duration=Number(process.env.SOAK_SECONDS||120)*1000;
if(!Number.isFinite(duration)||duration<=0)throw Error('SOAK_SECONDS must be positive');
const started=Date.now();
let cycles=0;
const samples=[];
while(Date.now()-started<duration){
 await evaluate(`(async()=>{
   if(!expandedCPUs.has('system.cpu'))toggleCPU('system.cpu');
   await seek('0'); await play();
   if(String(tick)!==meta.max_tick)throw Error('Playback did not reach end');
   if(!document.querySelector('[data-cpu-module="system.cpu.decode"]'))throw Error('Lost expanded CPU');
   toggleCPU('system.cpu');
   if(document.querySelector('[data-cpu-group]'))throw Error('Collapse failed');
   toggleCPU('system.cpu');
   await seek('500');
   if(!document.querySelector('[data-module-status="system.cpu.decode"]').textContent.includes('empty input'))throw Error('Wrong Decode state');
   await seek('1001');
   if(!document.querySelector('[data-module-status="system.cpu.decode"]').textContent.includes('unknown'))throw Error('Stale Decode state');
   await loadTimeline();
   if(!document.querySelector('#error').hidden)throw Error(document.querySelector('#error').textContent);
 })()`);
 cycles++;
 if(cycles%20===0){
   const sample=await evaluate('({elements:document.querySelectorAll("*").length,heap:performance.memory?.usedJSHeapSize})');
   samples.push(sample);
   console.log(JSON.stringify({cycles,elapsedSeconds:Math.round((Date.now()-started)/1000),...sample}));
 }
 if(errors.length)throw Error('Browser errors: '+JSON.stringify(errors));
}
const result={durationSeconds:(Date.now()-started)/1000,cycles,browserErrors:errors.length,samples};
fs.mkdirSync('artifacts',{recursive:true});
fs.writeFileSync('artifacts/soak-results.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
await evaluate("seek('500')");
if(errors.length)throw Error('Browser errors: '+JSON.stringify(errors));
const shot=await call('Page.captureScreenshot',{format:'png'});
const output=process.argv[2]||'artifacts/viewer.png';
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
console.log('Browser endurance checks passed; screenshot saved.');
}finally{ws.close();}

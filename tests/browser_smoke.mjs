// Runs against a dedicated Chrome CDP instance; no external dependencies.
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
console.log(await evaluate(`(async()=>{
 await seek('500'); choose('system.cpu.decode');
 if(!document.querySelector('#details').innerText.includes('empty input'))throw Error('Decode bubble absent');
 await seek('1000'); if(!document.querySelector('#details').innerText.includes('processing'))throw Error('Decode resume absent');
 await seek('1001'); if(!document.querySelector('#details').innerText.includes('Current activity unknown'))throw Error('Unobserved tick incorrectly shown active');
 await seek('0'); if(!snap.pending.length)throw Error('Initial event schedules missing');
 await seek('500');choose('system.cpu.dcache.cpu_side');if(snap.states[selected]?.accepts_new_requests?.value!==false)throw Error('Cache port blocking missing');
 await seek('1001');if(!snap.at.some(r=>r.kind==='port'&&r.payload.action==='sendRetryReq'))throw Error('Native retry missing');
 choose('system.cpu.decode');
 await seek('500'); document.querySelector('#logSearch').value='[sn:1]'; await loadLogs();
 if(!document.querySelector('#logs').innerText.includes('[sn:1]'))throw Error('Log search failed');
 document.querySelector('#nodeSearch').value='dcache';drawTree();
 if(!document.querySelector('#tree').innerText.includes('dcache'))throw Error('Tree search failed');
 document.querySelector('#nodeSearch').value='';drawTree();
 document.querySelector('#logSearch').value=''; await loadLogs();
 const pendingBefore=snap.pending.length;await step('next');await step('prev');
 if(String(tick)!=='500')throw Error('Tick navigation not reversible');
 document.querySelector('#lo').value='0';document.querySelector('#hi').value='1500';await loadTimeline();
 return {ready:window.viewerReady,nodes:meta.nodes.length,records:meta.counts,pending:pendingBefore,range:[String(windowLo),String(windowHi)]};
})()`));
if(errors.length)throw Error('Browser errors: '+JSON.stringify(errors));
const shot=await call('Page.captureScreenshot',{format:'png'});
const output=process.argv[2]||'artifacts/viewer.png';
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
console.log('Browser smoke checks passed; screenshot saved.');
}finally{ws.close();}

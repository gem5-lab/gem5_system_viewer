'use strict';
const $=id=>document.getElementById(id), NS='http://www.w3.org/2000/svg';
let meta,nodes,snap,tick=0n,seq=null,selected='',windowLo,windowHi,timeline,playing=false,offset=0,request=0,view,baseView,drag;
const expandedCPUs = new Set();
const fmt=x=>BigInt(x).toLocaleString('en-US');
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function svg(tag,attrs){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;}
// UML-inspired notation: cuboids are simulation nodes, inset glyphs are components.
function deploymentNode(parent,x,y,width,height,fill,stroke) {
  const depth=12;
  parent.append(svg('path',{'data-uml':'node',d:`M ${x} ${y} l ${depth} ${-depth} h ${width} v ${height} l ${-depth} ${depth} M ${x+width} ${y} l ${depth} ${-depth} M ${x} ${y} h ${width} v ${height} h ${-width} Z`,fill,stroke,'stroke-width':2,'stroke-linejoin':'round'}));
}
function componentGlyph(parent,x,y,scale=1) {
  const icon=svg('g',{'data-uml':'component',transform:`translate(${x} ${y}) scale(${scale})`,fill:'#192a3c',stroke:'#8fa6bc','stroke-width':1.5,'aria-hidden':'true'});
  icon.append(svg('rect',{x:5,y:0,width:19,height:22}),svg('rect',{x:0,y:4,width:10,height:5}),svg('rect',{x:0,y:13,width:10,height:5}));
  parent.append(icon);
}
function error(e){$('error').hidden=false;$('error').textContent=e.message||String(e);}
async function api(path,args={}){const q=new URLSearchParams();for(const[k,v]of Object.entries(args))if(v!==null&&v!==undefined)q.set(k,String(v));const r=await fetch('/api/'+path+'?'+q);if(!r.ok)throw Error('Request failed: '+r.status+' '+await r.text());return r.json();}
function clamp(t){return t<BigInt(meta.min_tick)?BigInt(meta.min_tick):t>BigInt(meta.max_tick)?BigInt(meta.max_tick):t;}
function safe(fn){return(...args)=>Promise.resolve().then(()=>fn(...args)).catch(error);}
async function seek(value,record=null){const id=++request;const next=clamp(BigInt(value));const data=await api('snapshot',{tick:next,seq:record});if(id!==request)return;tick=next;seq=record;snap=data;$('tick').value=String(tick);$('cursor').textContent=record===null?'End of tick · logged state':'After record #'+record;$('scrubber').value=String((tick-BigInt(meta.min_tick))*100000n/(BigInt(meta.max_tick)-BigInt(meta.min_tick)||1n));renderSnapshot();drawTimeline();}
function choose(id){selected=id;drawTree();renderSnapshot();if($('selectedOnly').checked){offset=0;loadLogs().catch(error);}}
function drawTree(){const q=$('nodeSearch').value.toLowerCase();const root=$('tree');root.replaceChildren();const order={model:0,port:2,component:1,infrastructure:3};const sorted=[...meta.nodes].sort((a,b)=>(order[a.kind]-order[b.kind])||a.id.localeCompare(b.id));const children=new Map();for(const n of sorted){const parent=nodes.has(n.parent)?n.parent:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(n);}const seen=new Set();function add(n,depth){if(seen.has(n.id))return;seen.add(n.id);if((n.id+' '+n.type).toLowerCase().includes(q)){const b=el('button',undefined,'node'+(n.id===selected?' selected':''));b.title=n.id;b.append(el('span',n.kind.toUpperCase().slice(0,4),'kind'),document.createTextNode(n.id));b.style.paddingLeft=Math.min(depth,5)*7+4+'px';b.onclick=()=>choose(n.id);root.append(b);}for(const c of children.get(n.id)||[])add(c,depth+1);}for(const n of children.get(null)||[])add(n,0);}

function ancestors(id){const a=[];while(id&&nodes.has(id)&&!a.includes(id)){a.push(id);id=nodes.get(id).parent;}return a;}
function activeModels(){const active=new Set();for(const r of snap.at)for(const id of ancestors(r.component))active.add(id);return active;}
function drawGraph(){const g=$('graph');g.replaceChildren();const defs=svg('defs',{});const marker=svg('marker',{id:'arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M0 0 L10 5 L0 10 Z',fill:'#66829b'}));defs.append(marker);g.append(defs);const graphPositions={...meta.positions};for(const cpu of CpuModules.cpus(meta)){if(!graphPositions[cpu.id])graphPositions[cpu.id]={x:2,y:-Object.keys(graphPositions).length};}const points=Object.entries(graphPositions);if(!points.length){g.append(svg('text',{x:10,y:30}));g.lastChild.textContent='No configured port graph';return;}
const pos=Object.fromEntries(points.map(([id,p])=>[id,{x:p.x*170,y:-p.y*100}]));const xs=Object.values(pos).map(p=>p.x),ys=Object.values(pos).map(p=>p.y);baseView=[Math.min(...xs)-160,Math.min(...ys)-55,Math.max(...xs)-Math.min(...xs)+320,Math.max(...ys)-Math.min(...ys)+110];const cpuGroups=layoutCpuGroups(pos,baseView);if(cpuGroups.length){baseView[2]=Math.max(baseView[2],940);baseView[3]=cpuGroups[cpuGroups.length-1].bottom-baseView[1]+20;baseView[0]-=20;baseView[2]+=40;}if(!view)view=[...baseView];g.setAttribute('viewBox',view.join(' '));g.parentElement.style.height=cpuGroups.length?Math.max(620,Math.min(1800,baseView[3]/baseView[2]*g.parentElement.clientWidth+30))+'px':'';const active=activeModels();const portEvents=snap.at.filter(r=>r.kind==='port');
for(const e of meta.graph_edges){const a=pos[e.source],b=pos[e.target];if(!a||!b)continue;const lit=portEvents.some(r=>((r.payload.source===e.ports.source&&r.payload.target===e.ports.target)||(r.payload.source===e.ports.target&&r.payload.target===e.ports.source)));const line=svg('path',{'data-uml':'communication-path',d:`M ${a.x+125} ${a.y} C ${a.x+160} ${a.y},${b.x-160} ${b.y},${b.x-125} ${b.y}`,fill:'none',stroke:lit?'#ffbe72':snap.states[e.ports.target]?.accepts_new_requests?.value===false?'#e78086':'#415a72','stroke-width':lit?5:2,'marker-end':'url(#arrow)',tabindex:0,role:'button','aria-label':e.ports.source+' to '+e.ports.target});const title=svg('title',{});title.textContent=e.ports.source+' → '+e.ports.target;line.append(title);for(const endpoint of [a,b]){const port=svg('rect',{'data-uml':'port',x:endpoint.x+(endpoint===a?125:-125)-5,y:endpoint.y-5,width:10,height:10,fill:lit?'#ffbe72':'#131e2d',stroke:lit?'#ffbe72':'#8fa6bc','stroke-width':2});g.append(port);}line.onclick=()=>choose(e.ports.source);line.onkeydown=ev=>{if(ev.key==='Enter')choose(e.ports.source);};g.append(line);}
for(const [id,p]of Object.entries(pos)){const group=svg('g',{tabindex:0,role:'button','aria-label':id});group.style.cursor='pointer';const lit=active.has(id);deploymentNode(group,p.x-125,p.y-36,250,80,lit?'#173c53':'#192a3c',id===selected?'#fff':lit?'#68c8ff':'#3a5068');const stereotype=svg('text',{x:p.x,y:p.y-19,'text-anchor':'middle',fill:'#8fa6bc','font-size':13});stereotype.textContent='«node»';group.append(stereotype);const name=svg('text',{x:p.x,y:p.y+2,'text-anchor':'middle',fill:'#e1edf8','font-size':25,'font-family':'monospace'});name.textContent=id.split('.').slice(id.endsWith('walker')?-2:-1).join('.');group.append(name);const title=svg('title',{});title.textContent=id;group.append(title);const kind=svg('text',{x:p.x,y:p.y+26,'text-anchor':'middle',fill:lit?'#68c8ff':'#8fa6bc','font-size':19});kind.textContent=(nodes.get(id)?.type||'Model');group.append(kind);if(CpuModules.cpus(meta).some(cpu=>cpu.id===id)){const toggle=svg('text',{x:p.x+106,y:p.y-8,fill:'#ffbe72','font-size':23,role:'button',tabindex:0,'aria-label':(expandedCPUs.has(id)?'Collapse ':'Expand ')+id,'aria-expanded':expandedCPUs.has(id)});toggle.textContent=expandedCPUs.has(id)?'−':'+';const activate=ev=>{ev.stopPropagation();toggleCPU(id);};toggle.onclick=activate;toggle.onkeydown=ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();activate(ev);}};group.append(toggle);}group.onclick=()=>choose(id);group.onkeydown=ev=>{if(ev.key==='Enter')choose(id);};g.append(group);}for(const port of [...g.querySelectorAll('[data-uml="port"]')])g.append(port);drawCpuGroups(g,cpuGroups,pos);updateCPUControl();}

function toggleCPU(id) {
  if (!id) return;
  if (expandedCPUs.has(id)) expandedCPUs.delete(id); else expandedCPUs.add(id);
  $('cpuSelect').value = id;
  view = null;
  drawGraph();
}

function updateCPUControl() {
  const id = $('cpuSelect').value;
  $('cpuToggle').disabled = !id;
  $('cpuToggle').textContent = expandedCPUs.has(id) ? 'Collapse CPU' : 'Expand CPU';
  $('cpuToggle').setAttribute('aria-expanded', String(expandedCPUs.has(id)));
}

function layoutCpuGroups(positions, bounds) {
  let top = bounds[1] + bounds[3] + 45;
  const groups = [];
  for (const cpu of CpuModules.cpus(meta)) {
    if (!expandedCPUs.has(cpu.id)) continue;
    const children = CpuModules.children(meta, cpu.id);
    const scale = Math.max(1,bounds[2]/900);
    const height = (78 + Math.max(1, Math.ceil(children.length / 3)) * 90)*scale;
    groups.push({id: cpu.id, children, scale, x: bounds[0], y: top, width: Math.max(900, bounds[2]), height, bottom: top + height});
    top += height + 45;
  }
  return groups;
}

function drawCpuGroups(graph, groups, positions) {
  for (const group of groups) {
    const root = svg('g', {'data-cpu-group': group.id});
    const scale=group.scale;
    const parent = positions[group.id];
    if (parent) root.append(svg('path', {d: `M ${parent.x} ${parent.y+44} L ${group.x+50} ${group.y}`, stroke: '#59728a', 'stroke-dasharray': '6 5', fill: 'none'}));
    deploymentNode(root,group.x,group.y,group.width,group.height,'#101d2c','#567a98');
    const title = svg('text', {x: group.x+18, y: group.y+28*scale, fill: '#dceafa', 'font-size': 21*scale});
    title.textContent = `«node» ${group.id} · ${group.children.length} submodules`;
    root.append(title);
    const note = svg('text', {x: group.x+18, y: group.y+51*scale, fill: '#95a8bc', 'font-size': 15*scale});
    note.textContent = 'Contains configured / traced submodules. Placement does not imply pipeline connections.';
    root.append(note);
    if (!group.children.length) {
      const empty = svg('text', {x: group.x+18, y: group.y+100*scale, fill: '#95a8bc', 'font-size': 19*scale});
      empty.textContent = 'No submodules captured for this CPU.';
      root.append(empty);
    }
    const width = (group.width-48)/3;
    group.children.forEach((node, index) => {
      const x = group.x+12+(index%3)*(width+12), y = group.y+68*scale+Math.floor(index/3)*90*scale;
      const state = CpuModules.status(snap,node.id,tick);
      const card = svg('g', {'data-cpu-module':node.id, role:'button', tabindex:0, 'aria-label':node.id+': '+state.label});
      card.style.cursor='pointer';
      card.append(svg('rect', {x,y,width,height:76*scale,rx:0,fill:state.kind==='unknown'?'#192a3c':'#173c53',stroke:selected===node.id?'#fff':state.kind==='unknown'?'#3a5068':'#68c8ff','stroke-width':2}));
      componentGlyph(card,x+width-32*scale,y+10*scale,scale);
      const label=svg('text',{x:x+10,y:y+23*scale,fill:'#e1edf8','font-size':21*scale});
      const short=node.id.slice(group.id.length+1);
      label.textContent=short.length>19?short.slice(0,18)+'…':short;
      card.append(label);
      const status=svg('text',{x:x+10,y:y+49*scale,fill:state.kind==='unknown'?'#93a6bd':'#68c8ff','font-size':17*scale,'data-module-status':node.id});
      status.textContent=state.label.length>31?state.label.slice(0,30)+'…':state.label;
      card.append(status);
      const tooltip=svg('title',{});tooltip.textContent=node.id+'\n'+state.label+'\n'+state.detail;card.append(tooltip);
      card.onclick=()=>choose(node.id);
      card.onkeydown=ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();choose(node.id);}};
      root.append(card);
    });
    graph.append(root);
  }
}

function recordButton(r){const b=el('button',undefined,'log');b.append(el('strong',fmt(r.tick)+'  '),document.createTextNode(r.message),el('small',r.component+' · '+r.source+':'+r.line+' · #'+r.id));b.onclick=safe(async()=>{selected=r.component;drawTree();await seek(r.tick,r.id);});return b;}
function renderSnapshot(){if(!snap)return;drawGraph();$('selectedName').textContent=selected||'Select a component';const d=$('details');d.replaceChildren();if(selected){const n=nodes.get(selected);d.append(el('span',n?.kind||'component','tag'),el('p',n?.type||''));const last=snap.latest.find(r=>r.component===selected);if(last){const exact=last.tick===String(tick);d.append(el('span',exact?(last.payload.observation||'recorded activity'):'Current activity unknown',exact?'tag':'tag unknown'));d.append(el('p','Last evidence at tick '+fmt(last.tick)+(exact?'':' (historical; not carried as state)')));d.append(recordButton(last));if(Object.keys(last.payload).length){const evidence=el('details');evidence.append(el('summary','Record payload'),el('pre',JSON.stringify(last.payload,null,2)));d.append(evidence);}}else d.append(el('span',snap.states[selected]?'Recorded state available':'No runtime evidence yet',snap.states[selected]?'tag':'tag unknown'));
const busy=snap.busy.find(r=>r.component===selected);if(busy)d.append(el('p','Explicit crossbar busy interval until tick '+fmt(busy.payload.busy_until),'warn'));
const fields=snap.states[selected];d.append(el('h3','Recorded state fields'));if(fields){for(const[k,v]of Object.entries(fields)){d.append(el('pre',k+' = '+JSON.stringify(v.value)+'\nupdated at '+v.tick));}}else d.append(el('p','Unknown — this capture has no explicit state fields for this component.'));
const peers=meta.edges.filter(e=>e.source===selected||e.target===selected||nodes.get(e.source)?.parent===selected||nodes.get(e.target)?.parent===selected);if(peers.length){d.append(el('h3','Port connections'));for(const e of peers){const b=el('button',e.source+' → '+e.target,'log');b.onclick=()=>choose(e.target);d.append(b);}}
if(n){const det=el('details');det.append(el('summary','Configuration parameters'),el('pre',JSON.stringify(n.params,null,2)));d.append(det);}}
$('pendingCount').textContent=snap.pending.length;$('pending').replaceChildren();for(const e of snap.pending.sort((a,b)=>BigInt(a.target||a.tick)<BigInt(b.target||b.tick)?-1:1)){const row=el('tr');const cell=el('td');const b=el('button',e.component+' #'+(e.payload.event_id||e.event_key));b.onclick=()=>choose(e.component);cell.append(b);row.append(cell,el('td',fmt(e.tick)),el('td',e.target?fmt(e.target):'unknown'),el('td',e.target?String(BigInt(e.target)-tick):'unknown',e.overdue?'warn':''));$('pending').append(row);}
$('atCount').textContent=snap.at_count+ (snap.at_count>snap.at.length?' (first '+snap.at.length+')':'');$('at').replaceChildren(...snap.at.map(recordButton));}
async function loadTimeline(){const lo=clamp(BigInt($('lo').value)),hi=clamp(BigInt($('hi').value));if(hi<lo)throw Error('Timeline end must be at or after its start');windowLo=lo;windowHi=hi;timeline=await api('timeline',{lo,hi,bins:160});drawTimeline();offset=0;await loadLogs();}
function drawTimeline(){if(!timeline)return;const host=$('timeline');host.replaceChildren();const q=$('trackSearch').value.toLowerCase();for(const[name,values]of Object.entries(timeline.tracks).filter(([n])=>n.toLowerCase().includes(q)).sort(([a],[b])=>a.localeCompare(b))){const row=el('div',undefined,'track'),label=el('button',name),canvas=el('canvas');label.title=name;label.onclick=()=>choose(name);canvas.width=800;canvas.height=26;const c=canvas.getContext('2d'),max=Math.max(...values,1);values.forEach((v,i)=>{c.fillStyle=v?`rgba(104,200,255,${.2+.8*Math.log1p(v)/Math.log1p(max)})`:'#1b2a3b';c.fillRect(i*800/values.length,2,800/values.length-1,22);});if(tick>=windowLo&&tick<=windowHi){const x=Number((tick-windowLo)*800n/(windowHi-windowLo+1n));c.fillStyle='#ffbe72';c.fillRect(x,0,2,26);}canvas.onclick=safe(async ev=>{const r=canvas.getBoundingClientRect(),bin=Math.min(values.length-1,Math.max(0,Math.floor((ev.clientX-r.left)/r.width*values.length)));const t=windowLo+(windowHi-windowLo+1n)*BigInt(bin)/BigInt(values.length);await seek(t);});canvas.onmousemove=ev=>{const r=canvas.getBoundingClientRect();const i=Math.min(values.length-1,Math.max(0,Math.floor((ev.clientX-r.left)/r.width*values.length)));canvas.title=values[i]+' logged records';};row.append(label,canvas);host.append(row);}}
async function loadLogs(){const data=await api('records',{lo:windowLo,hi:windowHi,component:$('selectedOnly').checked?selected:'',q:$('logSearch').value,offset,limit:100});$('logCount').textContent=data.total+' matches · '+Math.min(offset+1,data.total)+'–'+Math.min(offset+100,data.total);$('logs').replaceChildren(...data.records.map(recordButton));$('logPrev').disabled=offset===0;$('logNext').disabled=offset+100>=data.total;}
async function step(direction){const next=await api('step',{tick,direction,seq,mode:$('stepMode').value});if(next.tick===String(tick)&&next.seq===seq)return false;await seek(next.tick,next.seq);return true;}
async function play(){playing=!playing;$('play').textContent=playing?'❚❚ Pause':'▶ Play';while(playing){if(!await step('next'))playing=false;await new Promise(r=>setTimeout(r,120));}$('play').textContent='▶ Play';}
function zoom(f){if(!view)return;const cx=view[0]+view[2]/2,cy=view[1]+view[3]/2;view[2]*=f;view[3]*=f;view[0]=cx-view[2]/2;view[1]=cy-view[3]/2;$('graph').setAttribute('viewBox',view.join(' '));}
function bind(){
for(const cpu of CpuModules.cpus(meta)){const option=el('option',cpu.id);option.value=cpu.id;$('cpuSelect').append(option);}$('cpuToggle').onclick=()=>toggleCPU($('cpuSelect').value);$('cpuSelect').onchange=updateCPUControl;updateCPUControl();
$('go').onclick=safe(()=>seek($('tick').value));$('tick').onkeydown=safe(e=>{if(e.key==='Enter')return seek($('tick').value);});$('next').onclick=safe(()=>step('next'));$('prev').onclick=safe(()=>step('prev'));$('plus').onclick=safe(()=>seek(tick+1n));$('minus').onclick=safe(()=>seek(tick-1n));$('play').onclick=safe(play);$('scrubber').onchange=safe(()=>seek(BigInt(meta.min_tick)+(BigInt(meta.max_tick)-BigInt(meta.min_tick))*BigInt($('scrubber').value)/100000n));$('nodeSearch').oninput=drawTree;$('trackSearch').oninput=drawTimeline;$('windowGo').onclick=safe(loadTimeline);$('all').onclick=safe(()=>{$('lo').value=meta.min_tick;$('hi').value=meta.max_tick;return loadTimeline();});$('near').onclick=safe(()=>{$('lo').value=String(clamp(tick-5000n));$('hi').value=String(clamp(tick+5000n));return loadTimeline();});$('logGo').onclick=safe(()=>{offset=0;return loadLogs();});$('logSearch').onkeydown=safe(e=>{if(e.key==='Enter'){offset=0;return loadLogs();}});$('selectedOnly').onchange=safe(()=>{offset=0;return loadLogs();});$('logNext').onclick=safe(()=>{offset+=100;return loadLogs();});$('logPrev').onclick=safe(()=>{offset=Math.max(0,offset-100);return loadLogs();});$('fit').onclick=()=>{view=[...baseView];drawGraph();};$('zoomIn').onclick=()=>zoom(.8);$('zoomOut').onclick=()=>zoom(1.25);
$('graph').onpointerdown=e=>{if(e.target.closest('[role="button"]'))return;drag={x:e.clientX,y:e.clientY,view:[...view]};$('graph').setPointerCapture(e.pointerId);};$('graph').onpointermove=e=>{if(!drag)return;const r=$('graph').getBoundingClientRect();const scale=Math.max(drag.view[2]/r.width,drag.view[3]/r.height);view=[drag.view[0]-(e.clientX-drag.x)*scale,drag.view[1]-(e.clientY-drag.y)*scale,drag.view[2],drag.view[3]];$('graph').setAttribute('viewBox',view.join(' '));};$('graph').onpointerup=()=>drag=null;
$('bookmark').onclick=()=>{const key=String(tick)+(seq===null?'':':'+seq);const option=el('option',key);option.value=key;$('bookmarks').append(option);};$('bookmarks').onchange=safe(()=>{if(!$('bookmarks').value)return;const[t,s]=$('bookmarks').value.split(':');return seek(t,s?Number(s):null);});}
(async()=>{meta=await api('manifest');nodes=new Map(meta.nodes.map(n=>[n.id,n]));$('runName').textContent=meta.name;$('nodeCount').textContent=meta.nodes.length;$('first').textContent=fmt(meta.min_tick);$('last').textContent=fmt(meta.max_tick);$('coverage').textContent=meta.coverage+' Same-tick order follows trace records.';const hash=new URLSearchParams(location.hash.slice(1));tick=clamp(BigInt(hash.get('tick')||meta.min_tick));selected=hash.get('component')||(nodes.has('system.cpu.decode')?'system.cpu.decode':'');$('lo').value=String(clamp(tick-5000n));$('hi').value=String(clamp(tick+5000n));bind();drawTree();await seek(tick);await loadTimeline();window.viewerReady=true;})().catch(error);

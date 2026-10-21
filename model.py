"""Trace ingestion and tick-accurate replay. Python standard library only."""
import hashlib
import json
import re
import shlex
import sqlite3
import subprocess
from pathlib import Path

MAX_TICK = 2**64 - 1

def tick_key(value):
    if not re.fullmatch(r'\d+', str(value)) or not 0 <= int(value) <= MAX_TICK:
        raise ValueError('Tick must be an unsigned 64-bit integer')
    return f'{int(value):020d}'

def unpack(row):
    if row is None:
        return None
    d = dict(row)
    for k in ('tick', 'target'):
        if d.get(k) is not None:
            d[k] = str(int(d[k]))
    if 'payload' in d:
        d['payload'] = json.loads(d['payload'])
    return d

def topology(config):
    nodes, edges = {}, []
    def visit(obj, parent=None):
        if isinstance(obj, dict):
            path = obj.get('path')
            if path and 'type' in obj:
                nodes[path] = {'id': path, 'type': obj['type'], 'kind': 'model', 'parent': parent,
                               'params': {k: v for k,v in obj.items() if not isinstance(v,dict) and (not isinstance(v,list) or all(not isinstance(x,(dict,list)) for x in v))}}
                parent = path
                for key, port in obj.items():
                    if isinstance(port, dict) and 'peer' in port:
                        peers = port['peer'] if isinstance(port['peer'], list) else [port['peer']]
                        for i, peer in enumerate(peers):
                            name = path+'.'+key+(f'[{i}]' if isinstance(port['peer'],list) else '')
                            nodes[name] = {'id':name,'type':port.get('role','Port'),'kind':'port','parent':path,'params':{'peer':peer}}
                            if str(port.get('is_source')).lower() == 'true' and peer:
                                edges.append({'source':name,'target':peer,'kind':'port'})
            for v in obj.values():
                visit(v,parent)
        elif isinstance(obj,list):
            for v in obj: visit(v,parent)
    visit(config)
    for e in edges:
        if e['target'] not in nodes:
            nodes[e['target']]={'id':e['target'],'type':'Port','kind':'port','parent':e['target'].rsplit('.',1)[0],'params':{}}
    return nodes,edges

EVENT = re.compile(r'^(.*?) (\S+) (scheduled|rescheduled|descheduled|executed) @ (\d+)$')
LINE = re.compile(r'^\s*(\d+): (.*?): (.*)$')
BUSY = re.compile(r'The crossbar layer is now busy from tick (\d+) to (\d+)')

def parse_line(line, number):
    m=LINE.match(line.rstrip())
    if not m: return None
    tick,owner,message=m.groups()
    out={'tick':tick,'component':owner,'kind':'log','message':message,'line':number,'payload':{}}
    ev=EVENT.match(message)
    if ev:
        desc,ident,action,target=ev.groups()
        out.update(kind='event',action=action,event_key=owner+'#'+ident,target=target)
        out['payload']={'description':desc,'event_id':ident}
    else:
        busy=BUSY.search(message)
        if busy:
            out['payload']['busy_until']=busy[2]
        # These are observations at this tick, not persistent hidden state.
        if owner.endswith(('.decode','.fetch','.rename')):
            for needle,label in [('Nothing to do, breaking out early.','empty input'),('Done unblocking.','unblock sent'),('Blocking.','blocked'),('Fetch is waiting cache response!','cache wait'),('Processing instruction','processing'),('Sending instruction to decode','sending')]:
                if needle in message:
                    out['payload']['observation']=label
                    break
    return out

SCHEMA='''
CREATE TABLE records(id INTEGER PRIMARY KEY,tick TEXT NOT NULL,component TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,line INTEGER,source TEXT,payload TEXT NOT NULL,event_key TEXT,action TEXT,target TEXT);
CREATE TABLE fields(record_id INTEGER NOT NULL,component TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,tick TEXT NOT NULL);
CREATE INDEX rt ON records(tick,id);
CREATE INDEX rc ON records(component,tick,id);
CREATE INDEX re ON records(event_key,tick,id);
CREATE INDEX fk ON fields(component,name,tick,record_id);
'''

def build(run, out, structured=None):
    run, out=Path(run),Path(out)
    out.mkdir(parents=True,exist_ok=True)
    dbfile=out/'trace.sqlite'
    if dbfile.exists(): raise ValueError('Output already contains trace.sqlite; choose a fresh directory')
    nodes,edges=topology(json.loads((run/'config.json').read_text()))
    con=sqlite3.connect(dbfile); con.executescript(SCHEMA)
    stats=(run/'stats.txt').read_text() if (run/'stats.txt').exists() else ''
    freq=re.search(r'^simFreq\s+(\d+)',stats,re.M)
    freq=int(freq[1]) if freq else None
    ignored=0;counts={};source_paths=[run/'config.json',run/'debug_trace.txt']
    def insert(r, source):
        tick=tick_key(r['tick']); owner=r['component']
        if not isinstance(owner,str) or not owner: raise ValueError('Invalid component')
        state_owner=owner
        native_fields=None
        # Exact BaseCache::CacheResponsePort messages and verified config binding.
        if owner.endswith('.cpu_side_port'):
            canonical=owner[:-5]
            cache=owner.rsplit('.',1)[0]
            if nodes.get(cache,{}).get('type') in ('Cache','NoncoherentCache') and canonical in nodes:
                message=r.get('message','')
                if message in ('Port is blocking new requests','Port is accepting new requests'):
                    native_fields={'accepts_new_requests':message=='Port is accepting new requests'}
                    state_owner=canonical
                    r.setdefault('payload',{}).update(fields=native_fields,state_component=canonical,adapter='ClassicCache.CachePort')
                elif message=='Port is sending retry':
                    peer=nodes[canonical]['params'].get('peer')
                    if peer:r.update(kind='port',source=canonical,target=peer,action='sendRetryReq')
        kind=r.get('kind','log');payload=r.get('payload',{})
        if kind=='state':
            payload={'fields':r['fields']}
            if not isinstance(r['fields'],dict):raise ValueError('state.fields must be an object')
        elif kind=='port':
            payload={k:r[k] for k in ('source','target','transaction','action') if k in r}
            if not all(k in payload for k in ('source','target','action')):raise ValueError('Port record requires source, target, action')
        elif kind=='event':
            if r.get('action') not in ('scheduled','rescheduled','descheduled','executed'):raise ValueError('Invalid event action')
            if not r.get('event_key'):raise ValueError('Missing event_key')
        target=tick_key(r['target']) if kind=='event' and r.get('target') is not None else None
        if kind=='event' and r.get('action') in ('scheduled','rescheduled') and (target is None or target<tick):raise ValueError('Event scheduled in past or without target')
        if owner not in nodes:
            parents=[n for n in nodes if owner.startswith(n+'.')]
            nodes[owner]={'id':owner,'kind':'infrastructure' if kind=='event' else 'component','type':'Event owner' if kind=='event' else 'Logged component','parent':max(parents,key=len) if parents else None,'params':{}}
        cur=con.execute('INSERT INTO records(tick,component,kind,message,line,source,payload,event_key,action,target) VALUES(?,?,?,?,?,?,?,?,?,?)',
            (tick,owner,kind,r.get('message',kind),r.get('line'),source,json.dumps(payload),r.get('event_key'),r.get('action'),target))
        if kind=='state' or native_fields is not None:
            for name,value in (native_fields if native_fields is not None else payload['fields']).items():
                con.execute('INSERT INTO fields VALUES(?,?,?,?,?)',(cur.lastrowid,state_owner,name,json.dumps(value),tick))
        counts[kind]=counts.get(kind,0)+1
    try:
        with con:
            with (run/'debug_trace.txt').open(errors='replace') as f:
                for number,line in enumerate(f,1):
                    r=parse_line(line,number)
                    if r: insert(r,'debug_trace.txt')
                    else: ignored+=1
            if structured:
                source_paths.append(Path(structured))
                with Path(structured).open() as f:
                    for number,line in enumerate(f,1):
                        if line.strip():
                            r=json.loads(line);r['line']=number;insert(r,Path(structured).name)
        lo,hi=con.execute('SELECT min(tick),max(tick) FROM records').fetchone()
        if lo is None:raise ValueError('No timestamped records')
        con.execute('ANALYZE');con.commit()
    finally:con.close()
    # Graphviz lays out the model-level port graph; fine detail remains in the tree.
    model_edges=[]; graph_nodes=set()
    for edge in edges:
        a=nodes[edge['source']]['parent'];b=nodes[edge['target']]['parent']
        graph_nodes.update((a,b));model_edges.append({'source':a,'target':b,'ports':edge})
    dot=['digraph G { rankdir=LR; nodesep=0.5; ranksep=1.3; node [shape=box,width=2.6,height=0.8];']
    for n in sorted(graph_nodes):dot.append(json.dumps(n)+' [label='+json.dumps(n)+'];')
    for e in model_edges:dot.append(json.dumps(e['source'])+' -> '+json.dumps(e['target'])+';')
    dot.append('}');(out/'topology.dot').write_text('\n'.join(dot))
    positions={}
    if graph_nodes:
        result=subprocess.run(['dot','-Tplain',str(out/'topology.dot')],capture_output=True,text=True,check=True)
        for line in result.stdout.splitlines():
            parts=shlex.split(line)
            if parts and parts[0]=='node':positions[parts[1]]={'x':float(parts[2]),'y':float(parts[3])}
    meta={'name':run.parent.name,'min_tick':str(int(lo)),'max_tick':str(int(hi)),'tick_hz':freq,
          'counts':counts,'ignored_lines':ignored,'nodes':list(nodes.values()),'edges':edges,'graph_edges':model_edges,'positions':positions,
          'sources':{str(p.resolve()):hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths},
          'coverage':'Only logged observations are known. Event queue membership is reconstructed from observed lifecycle actions. Unlogged state is unknown.',
          'same_tick_order':'Text trace line order; structured sidecar follows text at equal ticks. Not a hardware priority ordering.'}
    (out/'manifest.json').write_text(json.dumps(meta,indent=2)+'\n')
    return meta

class Replay:
    def __init__(self, path):
        self.path=Path(path)
        self.meta=json.loads((self.path/'manifest.json').read_text())
        with self.connect() as c:
            self.components=[r[0] for r in c.execute('SELECT DISTINCT component FROM records')]
            self.event_keys=[r[0] for r in c.execute('SELECT DISTINCT event_key FROM records WHERE event_key IS NOT NULL')]
    def connect(self):
        c=sqlite3.connect('file:'+str((self.path/'trace.sqlite').resolve())+'?mode=ro',uri=True)
        c.row_factory=sqlite3.Row
        return c
    def snapshot(self,tick,seq=None):
        key=tick_key(tick); seq=int(seq) if seq is not None else 9223372036854775807
        cut='(tick < ? OR (tick = ? AND id <= ?))';args=(key,key,seq)
        with self.connect() as c:
            # Latest evidence per component, with no inferred state propagation.
            latest=[r for owner in self.components if (r:=c.execute(f'SELECT * FROM records WHERE component=? AND {cut} ORDER BY tick DESC,id DESC LIMIT 1',(owner,)+args).fetchone()) is not None]
            events=[r for event in self.event_keys if (r:=c.execute(f'SELECT * FROM records WHERE event_key=? AND {cut} ORDER BY tick DESC,id DESC LIMIT 1',(event,)+args).fetchone()) is not None]
            fields=c.execute('''SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY component,name ORDER BY tick DESC,record_id DESC) rn FROM fields WHERE tick < ? OR (tick=? AND record_id<=?)) WHERE rn=1''',args).fetchall()
            at=c.execute('SELECT * FROM records WHERE tick=? AND id<=? ORDER BY id LIMIT 1000',(key,seq)).fetchall()
            count=c.execute('SELECT count(*) FROM records WHERE tick=? AND id<=?',(key,seq)).fetchone()[0]
            busy=c.execute(f'''SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY component ORDER BY tick DESC,id DESC) rn FROM records WHERE payload LIKE '%busy_until%' AND {cut}) WHERE rn=1''',args).fetchall()
        states={}
        for r in fields:states.setdefault(r['component'],{})[r['name']]={'value':json.loads(r['value']),'tick':str(int(r['tick'])),'record_id':r['record_id']}
        pending=[unpack(e) for e in events if e['action'] in ('scheduled','rescheduled')]
        for e in pending:e['overdue']=e['target'] is not None and int(e['target'])<int(tick)
        return {'tick':str(int(key)),'seq':None if seq==9223372036854775807 else seq,'latest':[unpack(r) for r in latest],
                'events':[unpack(e) for e in events],'pending':pending,'states':states,'at':[unpack(r) for r in at],'at_count':count,
                'busy':[unpack(r) for r in busy if int(json.loads(r['payload'])['busy_until'])>int(tick)]}
    def records(self,lo,hi,component='',query='',offset=0,limit=200):
        with self.connect() as c:
            params=[tick_key(lo),tick_key(hi)];where='tick BETWEEN ? AND ?'
            if component:where+=' AND component=?';params.append(component)
            if query:where+=' AND instr(lower(message),lower(?))>0';params.append(query)
            count=c.execute('SELECT count(*) FROM records WHERE '+where,params).fetchone()[0]
            rows=c.execute('SELECT * FROM records WHERE '+where+' ORDER BY tick,id LIMIT ? OFFSET ?',params+[min(max(1,int(limit)),1000),max(0,int(offset))]).fetchall()
        return {'total':count,'records':[unpack(r) for r in rows]}
    def step(self,tick,direction,seq=None,mode='tick'):
        key=tick_key(tick);forward=direction=='next';op='>' if forward else '<';order='ASC' if forward else 'DESC'
        with self.connect() as c:
            if mode=='record':
                n=int(seq) if seq is not None else 9223372036854775807
                row=c.execute(f'SELECT tick,id FROM records WHERE tick {op} ? OR (tick=? AND id {op} ?) ORDER BY tick {order},id {order} LIMIT 1',(key,key,n)).fetchone()
            else:row=c.execute(f'SELECT tick,id FROM records WHERE tick {op} ? ORDER BY tick {order},id {order} LIMIT 1',(key,)).fetchone()
        return {'tick':str(int(row['tick'])) if row else str(int(key)),'seq':row['id'] if row and mode=='record' else (seq if mode=='record' and not row else None)}
    def timeline(self,lo,hi,bins=200):
        lo,hi=int(lo),int(hi);tick_key(lo);tick_key(hi)
        if hi<lo:raise ValueError('End tick precedes start')
        bins=min(max(int(bins),1),400);tracks={};span=hi-lo+1
        with self.connect() as c:
            for r in c.execute('SELECT tick,component FROM records WHERE tick BETWEEN ? AND ?',(tick_key(lo),tick_key(hi))):
                bucket=min(bins-1,(int(r['tick'])-lo)*bins//span)
                tracks.setdefault(r['component'],[0]*bins)[bucket]+=1
        return {'lo':str(lo),'hi':str(hi),'bins':bins,'tracks':tracks}
    def perfetto(self):
        if not self.meta['tick_hz']:raise ValueError('simFreq is required for Perfetto export')
        base=int(self.meta['min_tick']); scale=1e6/self.meta['tick_hz'];lanes={};events=[];pending={}
        def lane(owner):
            if owner not in lanes:
                lanes[owner]=len(lanes)+1;events.append({'ph':'M','name':'thread_name','pid':1,'tid':lanes[owner],'args':{'name':owner}})
            return lanes[owner]
        with self.connect() as c:
            for row in c.execute('SELECT * FROM records ORDER BY tick,id'):
                r=unpack(row);t=int(r['tick']);owner=r['component'];k=r['event_key']
                if k and k in pending:
                    start=pending.pop(k)
                    events.append({'ph':'X','name':'scheduled wait → '+r['action'],'pid':1,'tid':lane(k+' / pending'),'ts':(start-base)*scale,'dur':(t-start)*scale,'args':{'start_tick':str(start),'end_tick':str(t)}})
                if k and r['action'] in ('scheduled','rescheduled'):pending[k]=t
                events.append({'ph':'i','s':'t','name':r['message'],'pid':1,'tid':lane(owner),'ts':(t-base)*scale,'args':{'tick':r['tick'],'line':r['line'],'kind':r['kind']}})
        return {'traceEvents':events,'displayTimeUnit':'ns','gem5_base_tick':str(base)}

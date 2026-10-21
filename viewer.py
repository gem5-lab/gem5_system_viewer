#!/usr/bin/env python3
"""Build a trace dataset or serve the local gem5 System Viewer."""
import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import urlparse, parse_qs
from model import Replay, build

ROOT=Path(__file__).resolve().parent
class LocalServer(ThreadingHTTPServer):
    def server_bind(self):
        # A loopback-only server does not need reverse DNS at startup.
        TCPServer.server_bind(self)
        self.server_name='localhost'
        self.server_port=self.server_address[1]

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,replay,**kwargs):
        self.replay=replay
        super().__init__(*args,directory=str(ROOT/'dist'),**kwargs)
    def do_GET(self):
        p=urlparse(self.path)
        if not p.path.startswith('/api/'):
            return super().do_GET()
        try:
            q={k:v[0] for k,v in parse_qs(p.query).items()};r=self.replay;m=r.meta
            if p.path=='/api/manifest':data=m
            elif p.path=='/api/snapshot':data=r.snapshot(q.get('tick',m['min_tick']),q.get('seq'))
            elif p.path=='/api/records':data=r.records(q.get('lo',m['min_tick']),q.get('hi',m['max_tick']),q.get('component',''),q.get('q',''),q.get('offset',0),q.get('limit',200))
            elif p.path=='/api/step':data=r.step(q['tick'],q.get('direction','next'),q.get('seq'),q.get('mode','tick'))
            elif p.path=='/api/timeline':data=r.timeline(q.get('lo',m['min_tick']),q.get('hi',m['max_tick']),q.get('bins',200))
            elif p.path=='/api/perfetto':data=r.perfetto()
            else:self.send_error(404);return
            body=json.dumps(data).encode();self.send_response(200)
            self.send_header('Content-Type','application/json; charset=utf-8')
            if p.path=='/api/perfetto':self.send_header('Content-Disposition','attachment; filename="gem5-perfetto.json"')
            self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
        except (ValueError,KeyError) as e:
            self.send_error(400,str(e))
    def log_message(self,*args):pass

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('build');b.add_argument('--run',required=True,type=Path);b.add_argument('--out',required=True,type=Path);b.add_argument('--structured',type=Path)
    s=sub.add_parser('serve');s.add_argument('--data',required=True,type=Path);s.add_argument('--port',type=int,default=8765)
    args=p.parse_args()
    if args.command=='build':
        m=build(args.run,args.out,args.structured);print(json.dumps({k:m[k] for k in ('min_tick','max_tick','counts','ignored_lines')},indent=2))
    else:
        server=LocalServer(('127.0.0.1',args.port),partial(Handler,replay=Replay(args.data)))
        print(f'gem5 System Viewer: http://127.0.0.1:{server.server_port}',flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close()
if __name__=='__main__':main()

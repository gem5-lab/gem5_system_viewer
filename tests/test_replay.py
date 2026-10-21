import json
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from model import build, Replay, tick_key

class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.run=self.root/'run';self.run.mkdir()
        (self.run/'config.json').write_text(json.dumps({'path':'root','type':'Root','cpu':{'path':'system.cpu','type':'CPU'}}))
        (self.run/'stats.txt').write_text('simFreq 1000000000000\n')
    def replay(self,log,structured=None):
        (self.run/'debug_trace.txt').write_text(log)
        side=None
        if structured is not None:
            side=self.root/'state.jsonl';side.write_text('\n'.join(json.dumps(x) for x in structured))
        build(self.run,self.root/'data',side)
        return Replay(self.root/'data')
    def test_event_reschedule_cancel_and_same_tick_order(self):
        r=self.replay('10: q: Event 4 scheduled @ 20\n15: q: Event 4 rescheduled @ 30\n20: q: Event 4 descheduled @ 30\n20: q: Event 4 scheduled @ 25\n25: q: Event 4 executed @ 25\n25: q: Event 4 scheduled @ 40\n')
        self.assertEqual(r.snapshot(9)['pending'],[])
        self.assertEqual(r.snapshot(14)['pending'][0]['target'],'20')
        self.assertEqual(r.snapshot(19)['pending'][0]['target'],'30')
        self.assertEqual(r.snapshot(20,3)['pending'],[])
        self.assertEqual(r.snapshot(20)['pending'][0]['target'],'25')
        self.assertEqual(r.snapshot(25,5)['pending'],[])
        self.assertEqual(r.snapshot(25)['pending'][0]['target'],'40')
        self.assertEqual(r.step(20,'next',3,'record'),{'tick':'20','seq':4})
        self.assertEqual(r.step(20,'prev',4,'record'),{'tick':'20','seq':3})
        self.assertEqual(r.step(20,'prev',None,'record'),{'tick':'20','seq':4})
        self.assertEqual(r.step(10,'prev',1,'record'),{'tick':'10','seq':1})
    def test_padded_early_ticks_are_not_lost(self):
        r=self.replay('      0: q: Event 1 scheduled @ 500\n    500: q: Event 1 executed @ 500\n')
        self.assertEqual(r.meta['min_tick'],'0')
        self.assertEqual(r.meta['ignored_lines'],0)
        self.assertEqual(len(r.snapshot(0)['pending']),1)

    def test_large_unsigned_ticks_are_exact(self):
        t=2**64-10
        r=self.replay(f'{t}: q: Event 1 scheduled @ {t+5}\n{t+5}: q: Event 1 executed @ {t+5}\n')
        self.assertEqual(r.snapshot(t+1)['pending'][0]['target'],str(t+5))
        self.assertEqual(r.step(t,'next')['tick'],str(t+5))
        self.assertEqual(sum(r.timeline(t,t+5,4)['tracks']['q']),2)
        self.assertEqual(r.perfetto()['gem5_base_tick'],str(t))
    def test_partial_trace_never_backfills_unknown_schedule(self):
        r=self.replay('10: q: Event 1 executed @ 10\n15: q: Event 2 scheduled @ 20\n')
        self.assertEqual(r.snapshot(9)['pending'],[])
        self.assertEqual(r.snapshot(12)['pending'],[])
        self.assertTrue(r.snapshot(21)['pending'][0]['overdue'])
        self.assertFalse(any(e['ph']=='X' for e in r.perfetto()['traceEvents']))
    def test_explicit_state_carries_but_log_observation_does_not(self):
        r=self.replay('10: system.cpu.decode: [tid:0] Nothing to do, breaking out early.\n20: q: marker\n',[
            {'tick':'11','kind':'state','component':'system.cpu','fields':{'occupancy':4,'blocked':True}},
            {'tick':'15','kind':'state','component':'system.cpu','fields':{'occupancy':2}},
            {'tick':'16','kind':'port','component':'system.cpu.port','source':'system.cpu.port','target':'mem.port','action':'send','transaction':'a'}])
        self.assertEqual(r.snapshot(10)['states'],{})
        s=r.snapshot(18)
        self.assertEqual(s['states']['system.cpu']['occupancy']['value'],2)
        self.assertTrue(s['states']['system.cpu']['blocked']['value'])
        obs=next(x for x in s['latest'] if x['component']=='system.cpu.decode')
        self.assertEqual(obs['tick'],'10')
        self.assertFalse(any(x['component']=='system.cpu.decode' for x in s['at']))
        self.assertEqual(r.records(16,16)['records'][0]['payload']['transaction'],'a')
    def test_invalid_and_out_of_order(self):
        for t in (-1,2**64,'1.5','nan'):
            with self.assertRaises(ValueError):tick_key(t)
        r=self.replay('20: q: later\n10: q: earlier\n')
        self.assertEqual(r.records(0,30)['records'][0]['tick'],'10')
        self.assertEqual(r.snapshot(15)['latest'][0]['message'],'earlier')
    def test_crossbar_interval_is_explicit_and_half_open(self):
        r=self.replay('10: bus.layer: The crossbar layer is now busy from tick 10 to 20\n15: bus.layer: another message\n20: q: marker\n')
        self.assertEqual(len(r.snapshot(19)['busy']),1)
        self.assertEqual(r.snapshot(20)['busy'],[])
    def test_native_cache_port_state_and_retry(self):
        (self.run/'config.json').write_text(json.dumps({'path':'cache','type':'Cache','cpu_side':{'peer':'cpu.port','is_source':'False','role':'GEM5 RESPONDER'}}))
        r=self.replay('10: cache.cpu_side_port: Port is blocking new requests\n20: cache.cpu_side_port: Port is accepting new requests\n21: cache.cpu_side_port: Port is sending retry\n')
        self.assertFalse(r.snapshot(15)['states']['cache.cpu_side']['accepts_new_requests']['value'])
        self.assertTrue(r.snapshot(20)['states']['cache.cpu_side']['accepts_new_requests']['value'])
        retry=r.records(21,21)['records'][0]
        self.assertEqual(retry['kind'],'port')
        self.assertEqual(retry['payload']['source'],'cache.cpu_side')
        self.assertEqual(retry['payload']['target'],'cpu.port')

    def test_port_vector_topology(self):
        from model import topology
        config={'path':'system','type':'System','a':{'path':'a','type':'A','out':{'is_source':'True','peer':['b.in[0]','b.in[1]'],'role':'GEM5 REQUESTOR'}},'b':{'path':'b','type':'B','in':{'is_source':'False','peer':['a.out[0]','a.out[1]'],'role':'GEM5 RESPONDER'}}}
        nodes,edges=topology(config)
        self.assertEqual(len(edges),2)
        self.assertEqual(nodes['a.out[1]']['params']['peer'],'b.in[1]')
        self.assertEqual(nodes['b.in[0]']['parent'],'b')

if __name__=='__main__':unittest.main()

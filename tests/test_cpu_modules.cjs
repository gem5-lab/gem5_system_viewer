const assert = require('node:assert/strict');
const {cpus, children, status} = require('../dist/cpu.js');
const manifest = {nodes:[
  {id:'system.cpu',type:'BaseO3CPU',kind:'model'},
  {id:'system.cpu1',type:'TimingSimpleCPU',kind:'model'},
  {id:'system.cpu.decode',kind:'component'},
  {id:'system.cpu.iew.lsq',kind:'component'},
  {id:'system.cpu.branchPred',kind:'model'},
  {id:'system.cpu.branchPred.btb',kind:'model'},
  {id:'system.cpu.port',kind:'port'},
  {id:'system.cpu1.fetch',kind:'component'}
]};
assert.equal(cpus(manifest).length,2);
assert.deepEqual(children(manifest,'system.cpu').map(n=>n.id),['system.cpu.branchPred','system.cpu.decode','system.cpu.iew.lsq']);
const snapshot={states:{},latest:[{component:'system.cpu.decode',tick:'9007199254740993',payload:{observation:'empty input'},message:'Nothing to do'}]};
assert.equal(status(snapshot,'system.cpu.decode',9007199254740993n).label,'empty input');
assert.equal(status(snapshot,'system.cpu.decode',9007199254740994n).kind,'unknown');
assert.equal(status(snapshot,'system.cpu.fetch',9007199254740993n).kind,'unknown');
assert.equal(status(snapshot,'system.cpu',9007199254740993n).label,'submodule activity');
snapshot.states['system.cpu.decode']={blocked:{value:false,tick:'9007199254740993'}};
assert.equal(status(snapshot,'system.cpu.decode',9007199254740994n).kind,'state');
console.log('CPU discovery, grouping, multi-CPU isolation, exact ticks, and state semantics passed.');

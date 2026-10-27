'use strict';

// Configuration/trace-derived CPU groups. No assumed pipeline stages or links.
const CpuModules = (() => {
  function cpus(manifest) {
    return manifest.nodes.filter(n => n.kind === 'model' && /CPU$/i.test(n.type));
  }

  function children(manifest, cpu) {
    const candidates = manifest.nodes.filter(n => n.id.startsWith(cpu + '.') && n.kind !== 'port');
    const ids = new Set(candidates.map(n => n.id));
    // Show the first available descendant on each branch. Nested internals remain
    // accessible through the hierarchy and inspector, rather than duplicating them.
    return candidates.filter(n => {
      let parent = n.id.slice(0, n.id.lastIndexOf('.'));
      while (parent.length > cpu.length) {
        if (ids.has(parent)) return false;
        parent = parent.slice(0, parent.lastIndexOf('.'));
      }
      return true;
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  function status(snapshot, id, tick) {
    const fields = snapshot.states[id];
    const last = snapshot.latest.find(r => r.component === id);
    if (fields && Object.keys(fields).length) {
      const summary = Object.entries(fields).map(([key, field]) => `${key}: ${JSON.stringify(field.value)}`).join(' · ');
      return {label: summary, kind: 'state', detail: 'Recorded state; select to inspect values and update ticks.'};
    }
    if (last && last.tick === String(tick)) {
      return {label: last.payload.observation || 'recorded activity', kind: 'active', detail: last.message};
    }
    const descendants = snapshot.latest.filter(r => r.component.startsWith(id + '.') && r.tick === String(tick));
    if (descendants.length) return {label: 'submodule activity', kind: 'active', detail: `${descendants.length} descendant components have records at this tick; parent state is unknown.`};
    return {label: 'current state unknown', kind: 'unknown', detail: last ? `Last evidence at tick ${last.tick}; not carried forward as state.` : 'No runtime evidence at this tick.'};
  }
  return {cpus, children, status};
})();
if (typeof module !== 'undefined') module.exports = CpuModules;

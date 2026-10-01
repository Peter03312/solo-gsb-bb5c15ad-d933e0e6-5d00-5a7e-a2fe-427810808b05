import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, computeHash } from '../src/solver.js';
import { normalizeEntries, evaluateVerification } from '../src/verification.js';
import { ValidationError } from '../src/validate.js';

const base = (over = {}) => ({
  holes: 4,
  tolerance: 1,
  holeMaxMass: [100, 100, 100, 100],
  tubes: [],
  weights: [],
  ...over,
});
const allHoles = (n) => Array.from({ length: n }, (_, i) => i);

function freeze(data) {
  const result = solve(data);
  assert.equal(result.feasible, true, '测试数据需求解可行');
  return {
    id: 1,
    feasible: true,
    basisHash: computeHash(data),
    config: data,
    result,
  };
}

// 由冻结图生成“完全一致”的实测条目（质量可微调）
function exactEntries(pub, massOf = (m) => m) {
  return pub.result.arrangement.map((s, h) =>
    s ? { hole: h, ref: s.ref, mass: massOf(s.mass) } : { hole: h, ref: '', mass: 0 },
  );
}

test('与冻结图一致的实测通过，含逐孔/逐对明细', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50.5, usableHoles: allHoles(4) },
    ],
  });
  const pub = freeze(data);
  const entries = normalizeEntries(exactEntries(pub), 4);
  const r = evaluateVerification(pub, computeHash(data), entries);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.usable, true);
  assert.equal(r.details.holes.length, 4);
  assert.equal(r.details.pairs.length, 2);
  assert.ok(r.details.holes.every((h) => h.matched && h.capacityOk));
  assert.ok(Math.abs(r.details.diffSum - 0.5) < 1e-6);
});

test('空孔录入物件 / 应占孔留空均被定位', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const pub = freeze(data);
  const aHole = pub.result.arrangement.findIndex((s) => s && s.ref === 'A');
  const entries = exactEntries(pub);
  // 把 A 挪到某空孔，并把原孔留空
  const emptyHole = pub.result.arrangement.findIndex((s) => s === null);
  entries[aHole] = { hole: aHole, ref: '', mass: 0 };
  entries[emptyHole] = { hole: emptyHole, ref: 'A', mass: 50 };
  const r = evaluateVerification(pub, computeHash(data), entries);
  assert.equal(r.ok, false);
  const msg = r.errors.join(' ');
  assert.ok(msg.includes(`孔 ${aHole} 冻结图要求放置`));
  assert.ok(msg.includes(`孔 ${emptyHole} 冻结图为空孔`));
});

test('孔位物件放错被定位到具体孔位', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const pub = freeze(data);
  const entries = exactEntries(pub);
  const aHole = entries.findIndex((e) => e.ref === 'A');
  const bHole = entries.findIndex((e) => e.ref === 'B');
  entries[aHole].ref = 'B';
  entries[bHole].ref = 'A';
  const r = evaluateVerification(pub, computeHash(data), entries);
  assert.equal(r.ok, false);
  const msg = r.errors.join(' ');
  assert.ok(msg.includes(`孔 ${aHole} 物件不一致`));
  assert.ok(msg.includes(`孔 ${bHole} 物件不一致`));
});

test('实测质量超承重定位到孔位；对径差超限定位到孔对', () => {
  const data = base({
    tolerance: 1,
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const pub = freeze(data);
  const caps = data.holeMaxMass;

  // 1) 超承重：把 A 实测质量抬到其所在孔承重之上（保证定位到具体孔位）
  let entries = exactEntries(pub);
  const aHole = entries.findIndex((e) => e.ref === 'A');
  entries[aHole].mass = caps[aHole] + 10;
  let r = evaluateVerification(pub, computeHash(data), entries);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((m) => m.includes(`孔 ${aHole}`) && m.includes('最大承重')),
    `应定位孔 ${aHole} 超承重：${r.errors.join('；')}`,
  );

  // 2) 对径差超限：取冻结图中一对两侧都有物件的对径孔对，单侧抬高到差 > 容差但仍不超承重
  entries = exactEntries(pub);
  const pair = pub.result.pairs.find(
    (p) => entries[p.a].ref !== '' && entries[p.b].ref !== '',
  );
  assert.ok(pair, '该布置应存在两侧均有物件的对径孔对');
  entries[pair.a].mass = Math.min(
    entries[pair.b].mass + data.tolerance + 2,
    caps[pair.a] - 1,
  );
  r = evaluateVerification(pub, computeHash(data), entries);
  assert.equal(r.ok, false);
  const overPair = r.errors.find((m) => m.includes('对径孔对'));
  assert.ok(overPair, `应报告超容差孔对：${r.errors.join('；')}`);
  assert.ok(overPair.includes(`（${pair.a} ↔ ${pair.b}）`));
});

test('当前数据指纹与发布不一致时判定不可用', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const pub = freeze(data);
  const changed = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 51, usableHoles: allHoles(4) },
    ],
  });
  const r = evaluateVerification(pub, computeHash(changed), exactEntries(pub));
  assert.equal(r.ok, false);
  assert.equal(r.usable, false);
  assert.ok(r.errors.join(' ').includes('不可用于当前装载'));
});

test('normalizeEntries：空孔必须质量 0；实占必须正数；编号重复拒绝；长度不符拒绝', () => {
  assert.throws(
    () => normalizeEntries([], 4),
    (e) => e instanceof ValidationError && e.errors[0].includes('条目数量'),
  );
  assert.throws(
    () =>
      normalizeEntries(
        [
          { hole: 0, ref: 'A', mass: 0 },
          { hole: 1, ref: '', mass: 0 },
          { hole: 2, ref: '', mass: 0 },
          { hole: 3, ref: '', mass: 0 },
        ],
        4,
      ),
    (e) => e.errors.join(' ').includes('有限正数'),
  );
  assert.throws(
    () =>
      normalizeEntries(
        [
          { hole: 0, ref: 'A', mass: 50 },
          { hole: 1, ref: 'A', mass: 50 },
          { hole: 2, ref: '', mass: 0 },
          { hole: 3, ref: '', mass: 0 },
        ],
        4,
      ),
    (e) => e.errors.join(' ').includes('重复录入'),
  );
  assert.throws(
    () =>
      normalizeEntries(
        [
          { hole: 0, ref: '', mass: 3 },
          { hole: 1, ref: '', mass: 0 },
          { hole: 2, ref: '', mass: 0 },
          { hole: 3, ref: '', mass: 0 },
        ],
        4,
      ),
    (e) => e.errors.join(' ').includes('空孔，质量必须为 0'),
  );
  // 部分录入（未录孔为空）合法，可用于暂存
  const partial = normalizeEntries(
    [
      { hole: 0, ref: 'A', mass: 50 },
      { hole: 1, ref: '', mass: 0 },
      { hole: 2, ref: '', mass: 0 },
      { hole: 3, ref: '', mass: 0 },
    ],
    4,
  );
  assert.equal(partial.length, 4);
  assert.equal(partial[0].ref, 'A');
});

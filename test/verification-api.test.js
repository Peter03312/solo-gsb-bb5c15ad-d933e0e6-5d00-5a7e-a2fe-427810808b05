import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

// 由发布详情生成与冻结图一致的条目
async function exactEntries(pubId, massOf = (m) => m) {
  const r = await call('GET', `/api/publications/${pubId}`);
  return r.json.result.arrangement.map((s, h) =>
    s ? { hole: h, ref: s.ref, mass: massOf(s.mass) } : { hole: h, ref: '', mass: 0 },
  );
}
const emptyEntries = (n = 4) =>
  Array.from({ length: n }, (_, h) => ({ hole: h, ref: '', mass: 0 }));

async function publishBaseline() {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  const r = await call('POST', '/api/publish');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

test('准备：发布一条当前可用的装载图', async () => {
  const id = await publishBaseline();
  assert.equal(id, 1);
});

test('首次暂存无需版本号，返回 201 与 version=1', async () => {
  const r = await call('PUT', '/api/publications/1/verification', { entries: emptyEntries() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.created, true);
  assert.equal(r.json.verification.version, 1);
  assert.equal(r.json.verification.status, 'draft');
});

test('同一发布记录只有一份草稿（重复首存走更新但缺版本号 → 400）', async () => {
  const r = await call('PUT', '/api/publications/1/verification', { entries: emptyEntries() });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors[0].includes('版本号'));
  const list = await call('GET', '/api/verifications');
  assert.equal(list.json.length, 1);
});

test('草稿可恢复：GET 返回之前暂存内容', async () => {
  const entries = await exactEntries(1);
  // 只录第一孔
  const partial = emptyEntries();
  partial[0] = entries[0];
  let r = await call('PUT', '/api/publications/1/verification', { version: 1, entries: partial });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.verification.version, 2);
  r = await call('GET', '/api/publications/1/verification');
  assert.equal(r.json.verification.entries[0].ref, entries[0].ref);
  assert.equal(r.json.verification.entries[1].ref, '');
  // /api/state 也应包含核验
  const s = await call('GET', '/api/state');
  assert.equal(s.json.verifications.length, 1);
  assert.equal(s.json.verifications[0].status, 'draft');
});

test('过期版本更新被拒绝（409）并回传当前草稿', async () => {
  const r = await call('PUT', '/api/publications/1/verification', {
    version: 1,
    entries: emptyEntries(),
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.current.version, 2);
});

test('非正数实测质量暂存即拒绝（400）', async () => {
  const entries = emptyEntries();
  entries[0] = { hole: 0, ref: 'A', mass: -3 };
  const r = await call('PUT', '/api/publications/1/verification', { version: 2, entries });
  assert.equal(r.status, 400);
});

test('物件放错孔完成核验失败：400 定位孔位，草稿保留，无完成记录', async () => {
  const entries = await exactEntries(1);
  const aHole = entries.findIndex((e) => e.ref === 'A');
  const bHole = entries.findIndex((e) => e.ref === 'B');
  entries[aHole].ref = 'B';
  entries[bHole].ref = 'A';
  let r = await call('PUT', '/api/publications/1/verification', { version: 2, entries });
  assert.equal(r.status, 200);
  assert.equal(r.json.verification.version, 3);
  r = await call('POST', '/api/publications/1/verification/complete', { version: 3 });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes(`孔 ${aHole} 物件不一致`));
  // 草稿保留为 draft、版本未被完成动作改变
  const g = await call('GET', '/api/publications/1/verification');
  assert.equal(g.json.verification.status, 'draft');
  assert.equal(g.json.verification.version, 3);
  assert.equal(g.json.verification.result, null);
});

test('对径差超限完成失败并定位孔对', async () => {
  const entries = await exactEntries(1, (m) => m);
  const detail = await call('GET', '/api/publications/1');
  // 找到对径布置中 A、B 的孔，构造差 > 容差（直接改一孔质量，保证其仍 < 承重）
  const aHole = entries.findIndex((e) => e.ref === 'A');
  const partner = (aHole + 2) % 4;
  entries[aHole].mass = 53;
  // 对侧若为空孔（0），差 53 已 > 1；若为 B（50），差 3 > 1，两种情况都超限
  let r = await call('PUT', '/api/publications/1/verification', { version: 3, entries });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v4 = r.json.verification.version;
  r = await call('POST', '/api/publications/1/verification/complete', { version: v4 });
  assert.equal(r.status, 400);
  const err = r.json.errors.find((m) => m.includes('对径孔对'));
  assert.ok(err, `应报告孔对超限：${JSON.stringify(r.json.errors)}`);
  const wantA = Math.min(aHole, partner);
  const wantB = Math.max(aHole, partner);
  assert.ok(err.includes(`（${wantA} ↔ ${wantB}）`), err);
  // 取回细节
  const d = detail;
  assert.ok(d.json.result.pairs.length === 2);
});

test('正确实测完成核验：冻结结果（200），含判定明细与发布编号', async () => {
  const entries = await exactEntries(1, (m) => m + 0.1);
  let r = await call('PUT', '/api/publications/1/verification', { version: 4, entries });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v5 = r.json.verification.version;
  r = await call('POST', '/api/publications/1/verification/complete', { version: v5 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = r.json.verification;
  assert.equal(v.status, 'completed');
  assert.equal(v.result.passed, true);
  assert.equal(v.result.publicationId, 1);
  assert.ok(v.result.publicationBasisHash);
  assert.equal(v.result.details.holes.length, 4);
  assert.equal(v.result.details.pairs.length, 2);
  assert.ok(v.result.completedAt);
});

test('重复完成不生成第二份结果（repeated=true）', async () => {
  const before = await call('GET', '/api/verifications');
  assert.equal(before.json.length, 1);
  const r = await call('POST', '/api/publications/1/verification/complete', { version: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.repeated, true);
  const after = await call('GET', '/api/verifications');
  assert.equal(after.json.length, 1);
});

test('完成后修改录入被拒绝（409），已冻结结果不变', async () => {
  const entries = await exactEntries(1);
  const frozen = (await call('GET', '/api/publications/1/verification')).json.verification.result;
  const r = await call('PUT', '/api/publications/1/verification', { version: 5, entries });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors[0].includes('已完成'));
  const g = await call('GET', '/api/publications/1/verification');
  assert.deepEqual(g.json.verification.result, frozen);
});

test('录入数据变化后，对新发布记录发起核验被拒（不可用于当前装载）', async () => {
  // 再发一条（仍基于当前 hash），随后改变录入 → 该发布变为不可用
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  const pub = await call('POST', '/api/publish');
  const pubId = pub.json.id;
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 51)]);
  const r = await call('PUT', `/api/publications/${pubId}/verification`, {
    entries: emptyEntries(),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors[0].includes('不可用于当前装载'));
  // 未生成核验记录
  const list = await call('GET', '/api/verifications');
  assert.equal(list.json.length, 1);
});

test('不存在的发布记录返回 404；不存在核验的完成返回 400', async () => {
  let r = await call('GET', '/api/publications/999/verification');
  assert.equal(r.status, 404);
  r = await call('POST', '/api/publications/999/verification/complete', { version: 1 });
  assert.equal(r.status, 404);
});

// SQLite 数据访问层。
// 所有“多记录集合”的写入都在单个事务内整体替换：
// 任何校验错误都会 ROLLBACK，不会留下部分数据。

import Database from 'better-sqlite3';
import { computeHash } from './solver.js';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hole_count INTEGER NOT NULL,
  tolerance REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hole_max (
  hole INTEGER PRIMARY KEY,
  max_mass REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tubes (
  id TEXT PRIMARY KEY,
  mass REAL NOT NULL,
  ord INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tube_holes (
  tube_id TEXT NOT NULL REFERENCES tubes(id) ON DELETE CASCADE,
  hole INTEGER NOT NULL,
  PRIMARY KEY (tube_id, hole)
);

CREATE TABLE IF NOT EXISTS weights (
  mass REAL PRIMARY KEY,
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  reasons TEXT,
  result_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  weight_count INTEGER,
  diff_sum REAL,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  reasons TEXT
);

-- 现场装载核验：同一发布记录至多一份（UNIQUE），草稿可反复暂存（version 乐观锁），
-- 完成后结果冻结、不可再改。
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL UNIQUE REFERENCES publications(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'completed')),
  version INTEGER NOT NULL DEFAULT 1,
  hole_count INTEGER NOT NULL,
  entries_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
`;

// ---------- 读取 ----------

export function loadData(db) {
  const cfg = db.prepare('SELECT hole_count, tolerance FROM config WHERE id = 1').get();
  if (!cfg) return null;
  const N = cfg.hole_count;
  const hmRows = db.prepare('SELECT hole, max_mass FROM hole_max').all();
  const holeMaxMass = new Array(N).fill(null);
  for (const r of hmRows) {
    if (r.hole >= 0 && r.hole < N) holeMaxMass[r.hole] = r.max_mass;
  }
  const tubes = db
    .prepare('SELECT id, mass, ord FROM tubes ORDER BY ord, rowid')
    .all()
    .map((t) => ({
      id: t.id,
      mass: t.mass,
      usableHoles: db
        .prepare('SELECT hole FROM tube_holes WHERE tube_id = ? ORDER BY hole')
        .pluck()
        .all(t.id),
    }));
  const weights = db
    .prepare('SELECT mass, quantity FROM weights ORDER BY mass')
    .all()
    .map((w) => ({ mass: w.mass, quantity: w.quantity }));
  return {
    holes: N,
    tolerance: cfg.tolerance,
    holeMaxMass,
    tubes,
    weights,
  };
}

export function currentHash(db) {
  const data = loadData(db);
  return data ? computeHash(data) : null;
}

export function getDraft(db) {
  const row = db.prepare('SELECT * FROM drafts WHERE id = 1').get();
  if (!row) return null;
  return {
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    result: JSON.parse(row.result_json),
    computedAt: row.computed_at,
    stale: false, // 由调用方结合当前哈希填写
  };
}

export function listPublications(db) {
  return db
    .prepare(
      `SELECT id, created_at, basis_hash, feasible, weight_count, diff_sum, reasons
       FROM publications ORDER BY id DESC`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      basisHash: r.basis_hash,
      feasible: !!r.feasible,
      weightCount: r.weight_count,
      diffSum: r.diff_sum,
      reasons: r.reasons ? JSON.parse(r.reasons) : [],
    }));
}

export function getPublication(db, id) {
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    weightCount: row.weight_count,
    diffSum: row.diff_sum,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    config: JSON.parse(row.config_json),
    result: JSON.parse(row.result_json),
  };
}

// ---------- 草稿 ----------

export function saveDraft(db, { basisHash, feasible, reasons, result }) {
  db.prepare(
    `INSERT INTO drafts (id, basis_hash, feasible, reasons, result_json)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       basis_hash = excluded.basis_hash,
       feasible = excluded.feasible,
       reasons = excluded.reasons,
       result_json = excluded.result_json,
       computed_at = datetime('now')`,
  ).run(basisHash, feasible ? 1 : 0, JSON.stringify(reasons ?? []), JSON.stringify(result));
}

// ---------- 现场装载核验 ----------

function mapVerification(row) {
  if (!row) return null;
  const entries = JSON.parse(row.entries_json);
  // 冻结图需要现场录入的物件数（空孔无需录入），作为进度分母
  let requiredCount = null;
  if (row.pub_result_json) {
    const arr = JSON.parse(row.pub_result_json).arrangement;
    requiredCount = Array.isArray(arr) ? arr.filter((s) => s !== null).length : null;
  }
  return {
    id: row.id,
    publicationId: row.publication_id,
    status: row.status,
    version: row.version,
    holeCount: row.hole_count,
    entries,
    filledCount: entries.filter((e) => e.ref !== '').length,
    requiredCount,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

// 列表附带发布记录的可行性 / 数据指纹，供调用方标记“仍可用于当前装载”
export function listVerifications(db) {
  return db
    .prepare(
      `SELECT v.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible,
              p.result_json AS pub_result_json
       FROM verifications v
       JOIN publications p ON p.id = v.publication_id
       ORDER BY v.id DESC`,
    )
    .all()
    .map((row) => {
      const v = mapVerification(row);
      v.publicationBasisHash = row.pub_basis_hash;
      v.publicationFeasible = !!row.pub_feasible;
      return v;
    });
}

export function getVerificationByPublication(db, publicationId) {
  const row = db
    .prepare(
      `SELECT v.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible,
              p.result_json AS pub_result_json
       FROM verifications v
       JOIN publications p ON p.id = v.publication_id
       WHERE v.publication_id = ?`,
    )
    .get(publicationId);
  if (!row) return null;
  const v = mapVerification(row);
  v.publicationBasisHash = row.pub_basis_hash;
  v.publicationFeasible = !!row.pub_feasible;
  return v;
}

// 创建草稿；同一发布记录已存在核验时由 UNIQUE 约束拒绝（不静默覆盖）
export function insertVerification(db, { publicationId, holeCount, entries }) {
  const info = db
    .prepare(
      `INSERT INTO verifications (publication_id, status, version, hole_count, entries_json)
       VALUES (?, 'draft', 1, ?, ?)`,
    )
    .run(publicationId, holeCount, JSON.stringify(entries));
  return info.lastInsertRowid;
}

// 带乐观锁版本的草稿更新；返回 false 表示版本过期（他人已修改）
export function updateVerificationDraft(db, id, { version, entries }) {
  const info = db
    .prepare(
      `UPDATE verifications
       SET entries_json = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND status = 'draft' AND version = ?`,
    )
    .run(JSON.stringify(entries), id, version);
  return info.changes === 1;
}

// 完成核验：冻结实测结果；仅当仍为草稿且版本匹配时生效
export function completeVerification(db, id, { version, result, completedAt }) {
  const info = db
    .prepare(
      `UPDATE verifications
       SET status = 'completed', version = version + 1,
           result_json = ?, completed_at = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'draft' AND version = ?`,
    )
    .run(JSON.stringify(result), completedAt, id, version);
  return info.changes === 1;
}

// ---------- 发布（由 server 在单事务内调用） ----------

export function insertPublication(
  db,
  { basisHash, feasible, weightCount, diffSum, config, result, reasons },
) {
  const info = db
    .prepare(
      `INSERT INTO publications
         (basis_hash, feasible, weight_count, diff_sum, config_json, result_json, reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      basisHash,
      feasible ? 1 : 0,
      weightCount ?? null,
      diffSum ?? null,
      JSON.stringify(config),
      JSON.stringify(result),
      JSON.stringify(reasons ?? []),
    );
  return info.lastInsertRowid;
}

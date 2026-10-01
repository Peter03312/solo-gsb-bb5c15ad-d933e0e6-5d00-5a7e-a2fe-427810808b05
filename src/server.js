// Express 服务：REST API + 静态前端。
// 启动时自动建表；所有集合替换/发布均在 SQLite 事务中完成。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  loadData,
  currentHash,
  getDraft,
  saveDraft,
  listPublications,
  getPublication,
  insertPublication,
  listVerifications,
  getVerificationByPublication,
  insertVerification,
  updateVerificationDraft,
  completeVerification,
} from './db.js';
import { solve, verify, computeHash } from './solver.js';
import {
  ValidationError,
  validateConfig,
  validateTubes,
  validateWeights,
} from './validate.js';
import { normalizeEntries, evaluateVerification } from './verification.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 乐观锁版本冲突（409）
class ConflictError extends Error {
  constructor(message, current) {
    super(message);
    this.status = 409;
    this.current = current;
  }
}

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---------- 状态 ----------

  app.get('/api/state', (req, res) => {
    const data = loadData(db);
    const hash = data ? computeHash(data) : null;
    const rawDraft = getDraft(db);
    let draft = null;
    if (rawDraft) {
      draft = {
        ...rawDraft,
        stale: hash === null || rawDraft.basisHash !== hash,
      };
    }
    const publications = listPublications(db).map((p) => ({
      ...p,
      usable: hash !== null && p.feasible && p.basisHash === hash,
    }));
    const verifications = listVerifications(db).map((v) => ({
      ...v,
      usable: hash !== null && v.publicationFeasible && v.publicationBasisHash === hash,
    }));
    res.json({
      data,
      currentHash: hash,
      draft,
      publications,
      verifications,
    });
  });

  // ---------- 转子配置（整体替换，事务） ----------

  app.put('/api/config', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateConfig(body, current);
        db.prepare('DELETE FROM hole_max').run();
        db.prepare('DELETE FROM config').run();
        db.prepare('INSERT INTO config (id, hole_count, tolerance) VALUES (1, ?, ?)').run(
          clean.holes,
          clean.tolerance,
        );
        const ins = db.prepare('INSERT INTO hole_max (hole, max_mass) VALUES (?, ?)');
        clean.holeMaxMass.forEach((m, h) => ins.run(h, m));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心管（整表替换，事务） ----------

  app.put('/api/tubes', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateTubes(body, N);
        db.prepare('DELETE FROM tube_holes').run();
        db.prepare('DELETE FROM tubes').run();
        const insTube = db.prepare('INSERT INTO tubes (id, mass, ord) VALUES (?, ?, ?)');
        const insHole = db.prepare('INSERT INTO tube_holes (tube_id, hole) VALUES (?, ?)');
        clean.forEach((t, i) => {
          insTube.run(t.id, t.mass, i);
          for (const h of t.usableHoles) insHole.run(t.id, h);
        });
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块（整表替换，事务） ----------

  app.put('/api/weights', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateWeights(body, N);
        db.prepare('DELETE FROM weights').run();
        const ins = db.prepare('INSERT INTO weights (mass, quantity) VALUES (?, ?)');
        clean.forEach((w) => ins.run(w.mass, w.quantity));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 重算草稿 ----------

  app.post('/api/solve', (req, res, next) => {
    try {
      const data = loadData(db);
      if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
      const hash = computeHash(data);
      const result = solve(data);
      saveDraft(db, {
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
      res.json({
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 发布：事务内重读当前数据 → 求解 → 独立复核 → 冻结 ----------

  app.post('/api/publish', (req, res, next) => {
    try {
      let pubId;
      const tx = db.transaction(() => {
        const data = loadData(db);
        if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
        const hash = computeHash(data);
        const result = solve(data);
        if (!result.feasible) {
          throw new ValidationError([
            '当前数据不存在可行装载图，无法发布：',
            ...result.reasons,
          ]);
        }
        // 独立复核：不信任求解器输出本身
        const check = verify(data, result.arrangement);
        if (!check.ok) {
          throw new Error(`发布前独立复核失败：${check.errors.join('；')}`);
        }
        pubId = insertPublication(db, {
          basisHash: hash,
          feasible: true,
          weightCount: check.weightCount,
          diffSum: check.diffSum,
          config: data,
          result,
          reasons: [],
        });
      });
      tx();
      res.status(201).json(getPublication(db, pubId));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/publications', (req, res) => {
    const hash = currentHash(db);
    res.json(
      listPublications(db).map((p) => ({
        ...p,
        usable: hash !== null && p.feasible && p.basisHash === hash,
      })),
    );
  });

  app.get('/api/publications/:id', (req, res, next) => {
    const pub = getPublication(db, Number(req.params.id));
    if (!pub) return res.status(404).json({ error: '发布记录不存在' });
    const hash = currentHash(db);
    res.json({ ...pub, usable: pub.feasible && pub.basisHash === hash });
  });

  // ---------- 现场装载核验 ----------

  // 附带“发布记录仍可用于当前装载”标记
  function decorateVerification(v) {
    if (!v) return null;
    const hash = currentHash(db);
    return {
      ...v,
      usable: hash !== null && v.publicationFeasible && v.publicationBasisHash === hash,
    };
  }

  // 某发布记录的核验（草稿或已冻结结果）
  app.get('/api/publications/:id/verification', (req, res, next) => {
    try {
      const pubId = Number(req.params.id);
      const pub = getPublication(db, pubId);
      if (!pub) return res.status(404).json({ error: '发布记录不存在' });
      const v = decorateVerification(getVerificationByPublication(db, pubId));
      res.json({ verification: v });
    } catch (e) {
      next(e);
    }
  });

  // 全部核验记录
  app.get('/api/verifications', (req, res) => {
    res.json(listVerifications(db).map((v) => decorateVerification(v)));
  });

  // 暂存/更新草稿（同一发布记录至多一份；更新须携带版本号）
  app.put('/api/publications/:id/verification', (req, res, next) => {
    try {
      const pubId = Number(req.params.id);
      const pub = getPublication(db, pubId);
      if (!pub) return res.status(404).json({ error: '发布记录不存在' });
      if (!pub.feasible) {
        throw new ValidationError(['该发布记录不是可行装载图，不能发起核验']);
      }
      const hash = currentHash(db);
      if (hash === null || pub.basisHash !== hash) {
        throw new ValidationError([
          '发布记录已不可用于当前装载：录入数据相对冻结快照已变化，请改用与当前数据一致的发布记录',
        ]);
      }
      const entries = normalizeEntries(req.body?.entries, pub.config.holes);

      let created = false;
      let v;
      const tx = db.transaction(() => {
        // 事务内重读发布指纹，拒绝与他人的发布/录入变更竞争
        const pubNow = getPublication(db, pubId);
        const hashNow = currentHash(db);
        if (!pubNow || !pubNow.feasible || hashNow === null || pubNow.basisHash !== hashNow) {
          throw new ValidationError(['发布记录在保存期间已不可用于当前装载，请刷新后重试']);
        }
        const cur = getVerificationByPublication(db, pubId);
        if (cur && cur.status === 'completed') {
          throw new ConflictError('该发布记录的核验已完成并冻结，不能再修改', decorateVerification(cur));
        }
        if (cur) {
          const version = Number(req.body?.version);
          if (!Number.isInteger(version) || version <= 0) {
            throw new ValidationError(['更新草稿必须携带当前版本号 version']);
          }
          if (cur.version !== version) {
            throw new ConflictError(
              `版本已过期：你基于的版本为 ${version}，服务器当前版本为 ${cur.version}，请恢复最新草稿后再修改`,
              decorateVerification(cur),
            );
          }
          if (!updateVerificationDraft(db, cur.id, { version, entries })) {
            throw new ConflictError('草稿更新失败（版本冲突），请恢复最新草稿后再修改', decorateVerification(cur));
          }
          v = getVerificationByPublication(db, pubId);
        } else {
          insertVerification(db, { publicationId: pubId, holeCount: pub.config.holes, entries });
          created = true;
          v = getVerificationByPublication(db, pubId);
        }
      });
      tx();
      res.status(created ? 201 : 200).json({
        ok: true,
        created,
        verification: decorateVerification(v),
      });
    } catch (e) {
      next(e);
    }
  });

  // 完成核验：同一事务内重读发布快照与当前数据 → 逐项判定 → 冻结结果
  app.post('/api/publications/:id/verification/complete', (req, res, next) => {
    try {
      const pubId = Number(req.params.id);
      const pub = getPublication(db, pubId);
      if (!pub) return res.status(404).json({ error: '发布记录不存在' });
      const existing = getVerificationByPublication(db, pubId);
      if (!existing) {
        throw new ValidationError(['尚无核验草稿，请先按孔位录入并暂存']);
      }
      if (existing.status === 'completed') {
        // 幂等：重复完成不生成第二份结果，直接返回已冻结记录
        return res.json({ ok: true, repeated: true, verification: decorateVerification(existing) });
      }
      const version = Number(req.body?.version);
      if (!Number.isInteger(version) || version <= 0) {
        throw new ValidationError(['完成核验必须携带草稿当前版本号 version']);
      }

      let v;
      const tx = db.transaction(() => {
        const cur = getVerificationByPublication(db, pubId);
        if (!cur || cur.status !== 'draft') {
          throw new ConflictError('核验状态已变化，请刷新后重试', decorateVerification(cur));
        }
        if (cur.version !== version) {
          throw new ConflictError(
            `版本已过期：你基于的版本为 ${version}，服务器当前版本为 ${cur.version}，请恢复最新草稿后再完成`,
            decorateVerification(cur),
          );
        }
        // 同一事务内重读：冻结发布快照 + 当前录入数据指纹
        const pubNow = getPublication(db, pubId);
        const hashNow = currentHash(db);
        const entries = normalizeEntries(cur.entries, pubNow.config.holes);
        const evalResult = evaluateVerification(pubNow, hashNow, entries);
        if (!evalResult.ok) {
          // 核验不通过：回滚（草稿保留原状），不生成完成记录
          throw new ValidationError(evalResult.errors);
        }
        const completedAt = new Date().toISOString();
        const result = {
          passed: true,
          publicationId: pubId,
          publicationBasisHash: pubNow.basisHash,
          holeCount: pubNow.config.holes,
          tolerance: pubNow.config.tolerance,
          entries,
          details: evalResult.details,
          completedAt,
        };
        if (!completeVerification(db, cur.id, { version, result, completedAt })) {
          throw new ConflictError('核验完成失败（版本冲突），请刷新后重试', decorateVerification(cur));
        }
        v = getVerificationByPublication(db, pubId);
      });
      tx();
      res.status(200).json({ ok: true, verification: decorateVerification(v) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 静态前端 ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 错误处理 ----------

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message, errors: err.errors });
    }
    if (err instanceof ConflictError) {
      return res
        .status(409)
        .json({ error: err.message, errors: [err.message], current: err.current });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON', errors: ['请求体不是合法 JSON'] });
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误', errors: [String(err && err.message)] });
  });

  return app;
}

function start() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rotor.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`离心转子配平服务已启动: http://localhost:${port}  (数据库: ${dbPath})`);
  });
}

// 仅在直接运行时监听端口（测试中 import 不触发）
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start();
}

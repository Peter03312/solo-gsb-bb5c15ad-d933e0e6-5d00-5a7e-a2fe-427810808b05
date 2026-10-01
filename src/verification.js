// 现场装载核验：
//   - normalizeEntries：暂存草稿时的录入校验（结构、编号、正数质量、编号重复），
//     允许“尚未录全”（未录孔位为空孔形态：ref 为空、质量 0），但不允许结构非法。
//   - evaluateVerification：完成时在单事务内对“冻结发布快照 + 当前数据指纹 + 实测录入”
//     做独立判定。判定逻辑不信任求解器与客户端，任何问题都定位到具体孔位或孔对。
//
// 录入条目形态（长度恒为孔位数 N，按孔位升序）：
//   空孔：{ hole, ref: '', mass: 0 }
//   实占：{ hole, ref: '物件编号', mass: 有限正数 }

import { EPS, verify } from './solver.js';
import { ValidationError } from './validate.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const numText = (x) => String(Math.round(x * 1e6) / 1e6);

export function normalizeEntries(input, holeCount) {
  const errors = [];
  if (!Array.isArray(input)) throw new ValidationError(['核验条目必须是数组']);
  if (input.length !== holeCount) {
    throw new ValidationError([
      `核验条目数量（${input.length}）必须与冻结图孔位数（${holeCount}）一致`,
    ]);
  }

  const seen = new Map();
  const normalized = input.map((item, i) => {
    const where = `孔 ${i} 条目`;
    if (item === null || typeof item !== 'object') {
      errors.push(`${where}格式不正确`);
      return { hole: i, ref: '', mass: 0 };
    }
    if (!isInt(item.hole) || item.hole !== i) {
      errors.push(`${where}的孔位号必须为 ${i}（条目须按孔位升序排列）`);
    }
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    if (ref.length === 0) {
      // 空孔：质量必须为 0（缺省也按 0 处理）
      if (item.mass !== undefined && item.mass !== null && !(isNum(item.mass) && item.mass === 0)) {
        errors.push(`孔 ${i} 为空孔，质量必须为 0（当前：${item.mass}）`);
      }
      return { hole: i, ref: '', mass: 0 };
    }
    if (!isNum(item.mass) || item.mass <= 0) {
      errors.push(`孔 ${i} 物件「${ref}」实测质量必须为有限正数（当前：${item.mass}）`);
    }
    if (seen.has(ref)) {
      errors.push(`物件编号「${ref}」重复录入（孔 ${seen.get(ref)} 与孔 ${i}）`);
    } else {
      seen.set(ref, i);
    }
    return { hole: i, ref, mass: isNum(item.mass) ? item.mass : 0 };
  });

  if (errors.length) throw new ValidationError(errors);
  return normalized;
}

// 完成核验的独立判定（纯函数）。
// pub：getPublication 读出的冻结发布记录；currentHash：当前录入数据指纹；
// entries：normalizeEntries 归一化后的条目。
export function evaluateVerification(pub, currentHash, entries) {
  const errors = [];
  const data = pub.config;
  const N = data.holes;
  const m = N / 2;
  const tol = data.tolerance;
  const arrangement = pub.result.arrangement;

  // 发布记录仍可用于当前装载：指纹须与当前录入一致
  const usable = pub.feasible && pub.basisHash === currentHash;
  if (!pub.feasible) errors.push('该发布记录不是可行装载图，不能用于现场核验');
  if (pub.feasible && pub.basisHash !== currentHash) {
    errors.push('发布记录已不可用于当前装载：录入数据相对冻结快照已变化，请改用与当前数据一致的发布记录');
  }

  // 冻结图自身的不变量复核（正常发布不可能失败，属于防御性检查）
  const selfCheck = verify(data, arrangement);
  if (!selfCheck.ok) {
    errors.push(`冻结装载图快照自身复核失败：${selfCheck.errors.join('；')}`);
  }

  const refToHole = new Map();
  const holes = [];
  for (let h = 0; h < N; h += 1) {
    const frozen = arrangement[h] ?? null;
    const e = entries[h];
    const frozenRef = frozen ? frozen.ref : '';
    const item = {
      hole: h,
      frozenKind: frozen ? frozen.kind : 'empty',
      frozenRef,
      actualRef: e.ref,
      actualMass: e.ref === '' ? 0 : e.mass,
      occupied: e.ref !== '',
      matched: false,
      capacityOk: true,
    };

    if (e.ref !== '') {
      if (refToHole.has(e.ref)) {
        errors.push(`物件编号「${e.ref}」被重复录入（孔 ${refToHole.get(e.ref)} 与孔 ${h}）`);
      } else {
        refToHole.set(e.ref, h);
      }
      if (!frozen) {
        errors.push(`孔 ${h} 冻结图为空孔，但实际录入了物件「${e.ref}」`);
      } else if (frozen.ref !== e.ref) {
        errors.push(
          `孔 ${h} 物件不一致：冻结图要求「${frozen.ref}」，实际录入「${e.ref}」`,
        );
      }
      if (e.mass > data.holeMaxMass[h] + EPS) {
        item.capacityOk = false;
        errors.push(
          `孔 ${h} 实测质量 ${numText(e.mass)} 超过该孔最大承重 ${numText(data.holeMaxMass[h])}`,
        );
      }
    } else if (frozen) {
      errors.push(`孔 ${h} 冻结图要求放置「${frozen.ref}」，但实际为空孔`);
    }

    item.matched = frozenRef === e.ref;
    holes.push(item);
  }

  const pairs = [];
  let diffSum = 0;
  for (let i = 0; i < m; i += 1) {
    const a = i;
    const b = i + m;
    const massA = entries[a].ref === '' ? 0 : entries[a].mass;
    const massB = entries[b].ref === '' ? 0 : entries[b].mass;
    const diff = Math.abs(massA - massB);
    diffSum += diff;
    const within = diff <= tol + EPS;
    if (!within) {
      errors.push(
        `对径孔对（${a} ↔ ${b}）实测质量差 ${numText(diff)} 超过冻结容差 ${numText(tol)}`,
      );
    }
    pairs.push({ a, b, massA, massB, diff, tolerance: tol, withinTolerance: within });
  }

  return {
    ok: errors.length === 0,
    usable,
    errors,
    details: { holes, pairs, diffSum },
  };
}

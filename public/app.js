/* 离心转子配平前端（无框架，原生 JS） */

const $ = (sel) => document.querySelector(sel);
const holesSel = $('#holes');
for (let n = 4; n <= 12; n += 2) {
  const opt = document.createElement('option');
  opt.value = String(n);
  opt.textContent = `${n} 孔`;
  holesSel.appendChild(opt);
}

let state = null; // GET /api/state 的完整响应
// 编辑区本地缓冲
let editorN = null;
let tubeRows = []; // {id, mass, holes:Set}
let weightRows = []; // {mass, quantity}

// ---------- 通用 ----------

function showAlert(msg, kind = 'err') {
  const el = $('#alert');
  el.textContent = msg;
  el.className = `alert ${kind}`;
  el.scrollIntoView({ block: 'nearest' });
}
function clearAlert() {
  $('#alert').className = 'alert hidden';
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const list = json.errors && json.errors.length ? json.errors.join('\n') : json.error || '请求失败';
    const err = new Error(list);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}
const fmt = (x) => (typeof x === 'number' ? String(Math.round(x * 1e6) / 1e6) : x);

// ---------- 数据刷新 ----------

async function refresh(flash) {
  state = await api('GET', '/api/state');
  renderAll();
  if (flash) showAlert(flash, 'ok');
  else clearAlert();
}

function renderAll() {
  const d = state.data;
  $('#hashline').textContent = state.currentHash
    ? `当前数据指纹 sha256:${state.currentHash.slice(0, 16)}…`
    : '尚未配置转子';

  // 首次或孔位数变化时重建本地编辑缓冲
  const N = d ? d.holes : null;
  if (editorN !== N) {
    editorN = N;
    if (d) {
      holesSel.value = String(d.holes);
      $('#tolerance').value = d.tolerance;
      tubeRows = d.tubes.map((t) => ({
        id: t.id,
        mass: t.mass,
        holes: new Set(t.usableHoles),
      }));
      weightRows = d.weights.map((w) => ({ mass: w.mass, quantity: w.quantity }));
    }
  }

  renderHoleMax(d);
  renderTubeTable(N);
  renderWeightTable();
  renderDraft();
  renderPublications();
  renderVerificationList();
}

function renderHoleMax(d) {
  const N = d ? d.holes : Number(holesSel.value);
  const box = $('#holemax');
  if (box.childElementCount !== N) {
    box.innerHTML = '';
    for (let h = 0; h < N; h += 1) {
      const lab = document.createElement('label');
      lab.innerHTML = `孔 ${h}<input data-hole="${h}" type="number" step="0.0001" min="0">`;
      box.appendChild(lab);
    }
  }
  if (d) {
    box.querySelectorAll('input').forEach((inp) => {
      const h = Number(inp.dataset.hole);
      if (document.activeElement !== inp) inp.value = d.holeMaxMass[h];
    });
  }
}

holesSel.addEventListener('change', () => {
  editorN = Number(holesSel.value);
  renderHoleMax(null);
  renderTubeTable(editorN);
});

// ---------- 离心管表 ----------

function renderTubeTable(N) {
  const tbody = $('#tubes-table tbody');
  tbody.innerHTML = '';
  tubeRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    const idInp = document.createElement('input');
    idInp.type = 'text';
    idInp.value = row.id;
    idInp.placeholder = '如 T01';
    idInp.addEventListener('input', () => { row.id = idInp.value.trim(); });
    tdId.appendChild(idInp);

    const tdMass = document.createElement('td');
    const mInp = document.createElement('input');
    mInp.type = 'number';
    mInp.step = '0.0001';
    mInp.min = '0';
    mInp.value = row.mass;
    mInp.addEventListener('input', () => { row.mass = mInp.value; });
    tdMass.appendChild(mInp);

    const tdHoles = document.createElement('td');
    if (N) {
      const wrap = document.createElement('div');
      wrap.className = 'holes-checks';
      for (let h = 0; h < N; h += 1) {
        const lab = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = row.holes.has(h);
        cb.addEventListener('change', () => {
          if (cb.checked) row.holes.add(h);
          else row.holes.delete(h);
        });
        lab.append(cb, document.createTextNode(h));
        wrap.appendChild(lab);
      }
      tdHoles.appendChild(wrap);
    } else {
      tdHoles.textContent = '—';
      tdHoles.className = 'muted';
    }

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { tubeRows.splice(i, 1); renderTubeTable(N); });
    tdDel.appendChild(del);

    tr.append(tdId, tdMass, tdHoles, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-tube').addEventListener('click', () => {
  if (!editorN) return showAlert('请先保存转子配置（孔位数）。', 'err');
  const holes = new Set([0]);
  tubeRows.push({ id: '', mass: '', holes });
  renderTubeTable(editorN);
});

// ---------- 配重表 ----------

function renderWeightTable() {
  const tbody = $('#weights-table tbody');
  tbody.innerHTML = '';
  weightRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdMass = document.createElement('td');
    const mInp = document.createElement('input');
    mInp.type = 'number';
    mInp.step = '0.0001';
    mInp.min = '0';
    mInp.value = row.mass;
    mInp.addEventListener('input', () => { row.mass = mInp.value; });
    tdMass.appendChild(mInp);

    const tdQ = document.createElement('td');
    const qInp = document.createElement('input');
    qInp.type = 'number';
    qInp.step = '1';
    qInp.min = '1';
    qInp.value = row.quantity;
    qInp.addEventListener('input', () => { row.quantity = qInp.value; });
    tdQ.appendChild(qInp);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { weightRows.splice(i, 1); renderWeightTable(); });
    tdDel.appendChild(del);

    tr.append(tdMass, tdQ, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-weight').addEventListener('click', () => {
  if (!editorN) return showAlert('请先保存转子配置（孔位数）。', 'err');
  weightRows.push({ mass: '', quantity: 1 });
  renderWeightTable();
});

// ---------- 保存动作 ----------

$('#save-config').addEventListener('click', async () => {
  const holes = Number(holesSel.value);
  const tolerance = Number($('#tolerance').value);
  const holeMaxMass = [...$('#holemax').querySelectorAll('input')].map((i) => Number(i.value));
  try {
    await api('PUT', '/api/config', { holes, tolerance, holeMaxMass });
    await refresh('转子配置已保存。');
  } catch (e) { showAlert(e.message, 'err'); }
});

async function saveTubes() {
  if (!editorN) throw new Error('请先配置转子孔位数。');
  const body = tubeRows.map((r) => ({
    id: r.id,
    mass: Number(r.mass),
    usableHoles: [...r.holes].sort((a, b) => a - b),
  }));
  await api('PUT', '/api/tubes', body);
}

async function saveWeights() {
  if (!editorN) throw new Error('请先配置转子孔位数。');
  const body = weightRows.map((r) => ({ mass: Number(r.mass), quantity: Number(r.quantity) }));
  await api('PUT', '/api/weights', body);
}

$('#save-tubes').addEventListener('click', async () => {
  try {
    await saveTubes();
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('离心管已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('离心管已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

$('#save-weights').addEventListener('click', async () => {
  try {
    await saveWeights();
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('配重块已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('配重块已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 草稿展示 ----------

function slotHtml(h, slot) {
  if (!slot) {
    return `<div class="slot empty"><span class="hole-no">孔 ${h}</span>
      <span class="ref">空</span><span class="mass">0 g</span></div>`;
  }
  const cls = slot.kind === 'tube' ? 'tube' : 'weight';
  const tag = slot.kind === 'tube' ? '离心管' : '配重块';
  return `<div class="slot ${cls}"><span class="hole-no">孔 ${h}</span>
    <span class="ref">${escapeHtml(slot.ref)}</span>
    <span class="mass">${tag} · ${fmt(slot.mass)} g</span></div>`;
}

function arrangementHtml(result) {
  return `<div class="rotor-layout">${result.arrangement
    .map((s, h) => slotHtml(h, s))
    .join('')}</div>
  <table class="pair-list">
    <thead><tr><th>对径孔对</th><th>A 侧质量</th><th>B 侧质量</th><th>差值</th><th>容差判定</th></tr></thead>
    <tbody>${result.pairs
      .map(
        (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
        <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
        <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
          p.withinTolerance ? '✓ 合格' : '✗ 超限'
        }</td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function renderDraft() {
  const draft = state.draft;
  const staleBox = $('#draft-stale');
  const noneBox = $('#draft-none');
  const body = $('#draft-body');
  const pubBtn = $('#publish');

  if (!draft) {
    staleBox.classList.add('hidden');
    noneBox.classList.remove('hidden');
    body.classList.add('hidden');
    pubBtn.disabled = true;
    return;
  }
  noneBox.classList.add('hidden');
  staleBox.classList.toggle('hidden', !draft.stale);
  body.classList.remove('hidden');

  if (!draft.feasible) {
    body.innerHTML = `<div class="banner bad"><b>不存在可行装载图。</b><ul>${draft.reasons
      .map((r) => `<li>${escapeHtml(r)}</li>`)
      .join('')}</ul></div>`;
    pubBtn.disabled = true;
    return;
  }
  const r = draft.result;
  body.innerHTML = `
    <div class="metrics">
      <div>使用配重块：<b>${r.weightCount}</b> 枚（已最小化）</div>
      <div>各对径差之和：<b>${fmt(r.diffSum)}</b> g（同配重数下已最小化）</div>
    </div>
    ${arrangementHtml(r)}`;
  pubBtn.disabled = draft.stale;
}

$('#recompute').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('已按当前数据重算。', 'ok');
    else showAlert('不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

$('#publish').addEventListener('click', async () => {
  try {
    const pub = await api('POST', '/api/publish');
    await refresh(`已发布并冻结装载图 #${pub.id}（发布时基于当前数据复核通过）。`);
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 发布历史 ----------

function renderPublications() {
  const box = $('#pub-list');
  if (state.publications.length === 0) {
    box.innerHTML = '<div class="muted">暂无发布记录。</div>';
    return;
  }
  box.innerHTML = state.publications
    .map(
      (p) => `<div class="pub-row">
        <div>
          <button data-pub="${p.id}" class="pub-view">#${p.id}</button>
          <span class="muted">${p.createdAt}</span>
          ${p.feasible
            ? `<span class="muted">· 配重 ${p.weightCount} 枚 · 对径差和 ${fmt(p.diffSum)} g</span>`
            : '<span class="muted">· 不可行记录</span>'}
          ${p.feasible ? `<button data-verify="${p.id}" class="verify-btn">现场核验</button>` : ''}
        </div>
        <span class="badge ${p.usable ? 'ok' : 'stale'}">${
          p.usable ? '✓ 可用于当前装载' : '✗ 不可用于当前装载（数据已变化，旧图冻结不变）'
        }</span>
      </div>`,
    )
    .join('');
  box.querySelectorAll('.pub-view').forEach((b) =>
    b.addEventListener('click', () => openPublication(Number(b.dataset.pub))),
  );
  box.querySelectorAll('.verify-btn').forEach((b) =>
    b.addEventListener('click', () => openVerification(Number(b.dataset.verify))),
  );
}

async function openPublication(id) {
  const p = await api('GET', `/api/publications/${id}`);
  $('#pub-title').textContent = `已冻结装载图 #${p.id}`;
  const badge = p.usable
    ? '<span class="badge ok">✓ 可用于当前装载</span>'
    : '<span class="badge stale">✗ 不可用于当前装载</span>';
  $('#pub-detail').innerHTML = `
    <div class="actions" style="margin-top:0">${badge}
      <span class="muted">发布时间 ${p.createdAt}</span></div>
    <p class="muted" style="font-family:ui-monospace,monospace;font-size:12px">
      数据依据 sha256:${p.basisHash}</p>
    ${p.feasible
      ? `<div class="metrics">
          <div>配重块：<b>${p.weightCount}</b> 枚</div>
          <div>对径差之和：<b>${fmt(p.diffSum)}</b> g</div>
        </div>${arrangementHtml(p.result)}`
      : `<div class="banner bad">${p.reasons.map(escapeHtml).join('<br>')}</div>`}
    <details class="snapshot-block">
      <summary>发布时冻结的录入数据（依据快照）</summary>
      <pre>${escapeHtml(JSON.stringify(p.config, null, 2))}</pre>
    </details>`;
  $('#pub-dialog').showModal();
}
$('#pub-close').addEventListener('click', () => $('#pub-dialog').close());

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- 现场装载核验 ----------

let verifyCtx = null; // { pub, verification, rows:[{ref,mass}], version, usable, frozen }

function renderVerificationList() {
  const box = $('#verification-list');
  const vers = state.verifications || [];
  if (vers.length === 0) {
    box.innerHTML = '<div class="muted">暂无核验记录。在上方「已发布装载图」中对可用记录点击「现场核验」开始。</div>';
    return;
  }
  box.innerHTML = vers
    .map((v) => {
      const total = v.requiredCount ?? 0;
      const done = v.entries.filter((e) => e.ref !== '' && typeof e.mass === 'number' && e.mass > 0).length;
      const pct = total === 0 ? 100 : Math.round((done / total) * 100);
      const statusBadge =
        v.status === 'completed'
          ? `<span class="badge ok">✓ 已完成并冻结</span>`
          : `<span class="badge stale">草稿 ${done}/${total}（${pct}%）</span>`;
      return `<div class="pub-row">
        <div>
          <button data-open-verify="${v.publicationId}" class="pub-view">发布 #${v.publicationId} 的核验</button>
          <span class="muted">${v.status === 'completed' ? `完成于 ${v.completedAt}` : `暂存于 ${v.updatedAt}`}</span>
          <span class="muted">· v${v.version}</span>
        </div>
        <div class="verify-row-right">
          ${statusBadge}
          <span class="badge ${v.usable ? 'ok' : 'stale'}">${
            v.usable ? '发布仍可用于当前装载' : '发布已不可用于当前装载'
          }</span>
        </div>
      </div>`;
    })
    .join('');
  box.querySelectorAll('[data-open-verify]').forEach((b) =>
    b.addEventListener('click', () => openVerification(Number(b.dataset.openVerify))),
  );
}

async function openVerification(pubId) {
  try {
    const [pub, vr] = await Promise.all([
      api('GET', `/api/publications/${pubId}`),
      api('GET', `/api/publications/${pubId}/verification`),
    ]);
    const verification = vr.verification;
    const frozen = pub.result.arrangement;
    // 以服务端草稿恢复；无草稿则按冻结图初始化（实占孔待录、空孔预置为空）
    const rows = frozen.map((s, h) => {
      const saved = verification && verification.entries[h];
      if (saved) return { ref: saved.ref, mass: saved.ref === '' ? '' : saved.mass };
      return s ? { ref: s.ref, mass: '' } : { ref: '', mass: '' };
    });
    verifyCtx = {
      pub,
      verification,
      rows,
      version: verification ? verification.version : null,
      usable: pub.usable,
      frozen,
    };
    $('#verify-title').textContent = `现场装载核验 · 发布 #${pub.id}`;
    $('#verify-dialog').showModal();
    renderVerifyBody();
  } catch (e) {
    showAlert(e.message, 'err');
  }
}

function renderVerifyBody() {
  const { pub, verification, rows, usable, frozen } = verifyCtx;
  const detail = $('#verify-detail');
  const completed = verification && verification.status === 'completed';

  const head = `
    <div class="actions" style="margin-top:0">
      ${completed
        ? '<span class="badge ok">✓ 核验已通过并冻结</span>'
        : '<span class="badge stale">核验草稿</span>'}
      <span class="badge ${usable ? 'ok' : 'stale'}">${
        usable ? '发布仍可用于当前装载' : '发布已不可用于当前装载'
      }</span>
      <span class="muted">容差 ${fmt(pub.config.tolerance)} g · 孔位 ${pub.config.holes}</span>
      ${verifyCtx.version ? `<span class="muted">版本 v${verifyCtx.version}</span>` : ''}
    </div>
    <p class="muted" style="font-family:ui-monospace,monospace;font-size:12px">
      发布编号 #${pub.id} · 冻结指纹 sha256:${pub.basisHash}</p>`;

  if (completed) {
    detail.innerHTML = `${head}${verificationResultHtml(verification.result)}
      <p class="muted">完成时间：${verification.result.completedAt || verification.completedAt}。
      此后录入数据的任何修改都不会改写本核验结果。</p>`;
    return;
  }

  const total = frozen.filter(Boolean).length;
  const done = rows.filter((r, h) => frozen[h] && r.ref === frozen[h].ref && Number(r.mass) > 0).length;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);

  detail.innerHTML = `${head}
    ${!usable ? '<div class="banner bad">该发布记录已不可用于当前装载，无法完成核验；请改用与当前数据一致的发布记录。</div>' : ''}
    <div class="verify-progress">
      <div class="verify-progress-bar" style="width:${pct}%"></div>
    </div>
    <div class="muted verify-progress-text">录入进度 ${done}/${total}（${pct}%）</div>
    <div class="table-wrap">
      <table class="verify-table">
        <thead><tr>
          <th>孔位</th><th>冻结图物件</th><th>冻结质量</th><th>实际物件编号</th><th>实测质量 (g)</th><th>判定</th>
        </tr></thead>
        <tbody>${rows
          .map((r, h) => {
            const f = frozen[h];
            if (!f) {
              return `<tr class="verify-empty">
                <td>${h}</td><td class="muted">空</td><td class="muted">0</td>
                <td class="muted" colspan="2">空孔保持为空（质量 0，无需录入）</td><td>—</td></tr>`;
            }
            return `<tr>
              <td>${h}</td>
              <td><b>${escapeHtml(f.ref)}</b></td>
              <td>${fmt(f.mass)}</td>
              <td><input data-vref="${h}" type="text" value="${escapeHtml(r.ref)}"></td>
              <td><input data-vmass="${h}" type="number" step="0.0001" min="0" placeholder="实测 g" value="${r.mass === '' ? '' : fmt(r.mass)}"></td>
              <td data-vjudge="${h}"></td>
            </tr>`;
          })
          .join('')}</tbody>
      </table>
    </div>
    <div id="verify-pairs"></div>
    <div class="actions">
      <button id="verify-save" ${usable ? '' : 'disabled'}>暂存草稿</button>
      <button id="verify-complete" class="primary" ${usable ? '' : 'disabled'}>完成核验并冻结</button>
    </div>`;

  detail.querySelectorAll('[data-vref]').forEach((inp) => {
    inp.addEventListener('input', () => { verifyCtx.rows[Number(inp.dataset.vref)].ref = inp.value.trim(); updateVerifyHints(); });
  });
  detail.querySelectorAll('[data-vmass]').forEach((inp) => {
    inp.addEventListener('input', () => { verifyCtx.rows[Number(inp.dataset.vmass)].mass = inp.value; updateVerifyHints(); });
  });
  $('#verify-save').addEventListener('click', () => saveVerification(false));
  $('#verify-complete').addEventListener('click', () => saveVerification(true));
  updateVerifyHints();
}

// 前端即时提示（仅辅助，最终以服务端事务判定为准）
function updateVerifyHints() {
  const { rows, frozen, pub } = verifyCtx;
  const seen = new Map();
  rows.forEach((r, h) => {
    if (!frozen[h]) return;
    const td = document.querySelector(`[data-vjudge="${h}"]`);
    if (!td) return;
    const m = Number(r.mass);
    const refOk = r.ref === frozen[h].ref;
    const massOk = Number.isFinite(m) && m > 0;
    const cap = pub.config.holeMaxMass[h];
    let msg = '';
    let cls = '';
    if (!r.ref) { msg = '待录入'; cls = 'muted'; }
    else if (!refOk) { msg = `✗ 应为「${frozen[h].ref}」`; cls = 'tag-bad'; }
    else if (!massOk) { msg = '✗ 质量须为正数'; cls = 'tag-bad'; }
    else if (m > cap) { msg = `✗ 超承重 ${fmt(cap)}`; cls = 'tag-bad'; }
    else if (seen.has(r.ref)) { msg = `✗ 与孔 ${seen.get(r.ref)} 重复`; cls = 'tag-bad'; }
    else { msg = '✓'; cls = 'tag-ok'; }
    if (r.ref && refOk) seen.set(r.ref, h);
    td.className = cls;
    td.textContent = msg;
  });

  // 对径差即时预览
  const N = pub.config.holes;
  const half = N / 2;
  const tol = pub.config.tolerance;
  const pairBox = $('#verify-pairs');
  if (pairBox) {
    pairBox.innerHTML = `<table class="pair-list">
      <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>容差判定</th></tr></thead>
      <tbody>${Array.from({ length: half }, (_, i) => {
        const a = i;
        const b = i + half;
        const ma = frozen[a] && Number(rows[a].mass) > 0 ? Number(rows[a].mass) : null;
        const mb = frozen[b] && Number(rows[b].mass) > 0 ? Number(rows[b].mass) : null;
        let diffText = '—';
        let judge = '<td class="muted">待录入</td>';
        if (ma !== null && mb !== null) {
          const d = Math.abs(ma - mb);
          diffText = `${fmt(d)} g`;
          judge = d <= tol + 1e-7
            ? '<td class="tag-ok">✓ 合格</td>'
            : `<td class="tag-bad">✗ 超容差 ${fmt(tol)}</td>`;
        }
        return `<tr><td>${a} ↔ ${b}</td><td>${ma === null ? '—' : fmt(ma)}</td>
          <td>${mb === null ? '—' : fmt(mb)}</td><td>${diffText}</td>${judge}</tr>`;
      }).join('')}</tbody></table>`;
  }

  // 更新进度条
  const total = frozen.filter(Boolean).length;
  const done = rows.filter((r, h) => frozen[h] && r.ref === frozen[h].ref && Number(r.mass) > 0).length;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const bar = document.querySelector('.verify-progress-bar');
  const txt = document.querySelector('.verify-progress-text');
  if (bar) bar.style.width = `${pct}%`;
  if (txt) txt.textContent = `录入进度 ${done}/${total}（${pct}%）`;
}

// 收集服务端格式条目：空孔 → {ref:'',mass:0}；实占 → 录入值
function collectEntries() {
  const { rows, frozen } = verifyCtx;
  return frozen.map((f, h) => {
    if (!f) return { hole: h, ref: '', mass: 0 };
    return { hole: h, ref: rows[h].ref.trim(), mass: Number(rows[h].mass) };
  });
}

async function saveVerification(andComplete) {
  const entries = collectEntries();
  // 暂存允许录不全，但已填项必须合法（正数质量）
  for (const e of entries) {
    if (e.ref !== '' && !(Number.isFinite(e.mass) && e.mass > 0)) {
      showAlert(`孔 ${e.hole} 的实测质量必须为有限正数后才能${andComplete ? '完成核验' : '暂存'}。`, 'err');
      return;
    }
  }
  try {
    const body = { entries };
    if (verifyCtx.version !== null) body.version = verifyCtx.version;
    const saved = await api('PUT', `/api/publications/${verifyCtx.pub.id}/verification`, body);
    verifyCtx.verification = saved.verification;
    verifyCtx.version = saved.verification.version;
    if (!andComplete) {
      renderVerifyBody();
      await refresh();
      showAlert(`草稿已暂存（版本 v${saved.verification.version}），可随时恢复。`, 'ok');
      return;
    }
    const done = await api(
      'POST',
      `/api/publications/${verifyCtx.pub.id}/verification/complete`,
      { version: verifyCtx.version },
    );
    verifyCtx.verification = done.verification;
    verifyCtx.version = done.verification.version;
    renderVerifyBody();
    await refresh();
    showAlert(
      done.repeated ? '核验此前已完成，返回已冻结结果（不重复生成）。' : '核验通过，实测值与判定明细已冻结。',
      'ok',
    );
  } catch (e) {
    if (e.status === 409 && e.body && e.body.current) {
      // 版本冲突：加载服务器最新草稿供恢复
      verifyCtx.verification = e.body.current;
      verifyCtx.version = e.body.current.version;
      e.body.current.entries.forEach((en, h) => {
        verifyCtx.rows[h] = { ref: en.ref, mass: en.ref === '' ? '' : en.mass };
      });
      renderVerifyBody();
      await refresh();
      showAlert(`版本冲突，已为你恢复服务器上的最新草稿（v${verifyCtx.version}）：\n${e.message}`, 'err');
      return;
    }
    // 400：核验不通过或录入非法 —— 原因已定位到孔位/孔对，草稿保留
    showAlert(andComplete ? `核验未通过，草稿已保留：\n${e.message}` : e.message, 'err');
  }
}

function verificationResultHtml(result) {
  const { details, entries } = result;
  const rowsHtml = details.holes
    .map((hh) => {
      const frozenTxt = hh.frozenKind === 'empty' ? '空' : hh.frozenRef;
      const actualTxt = hh.occupied ? `${escapeHtml(hh.actualRef)} · ${fmt(hh.actualMass)} g` : '空（0 g）';
      const ok = hh.matched && hh.capacityOk;
      return `<tr>
        <td>${hh.hole}</td><td>${hh.frozenKind === 'empty' ? '<span class="muted">空</span>' : escapeHtml(hh.frozenRef)}</td>
        <td>${actualTxt}</td>
        <td class="${ok ? 'tag-ok' : 'tag-bad'}">${hh.matched ? (hh.capacityOk ? '✓ 一致且未超承重' : '✗ 超承重') : '✗ 物件不一致'}</td>
      </tr>`;
    })
    .join('');
  const pairsHtml = details.pairs
    .map(
      (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
        <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
        <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
          p.withinTolerance ? '✓ 合格' : '✗ 超限'
        }</td></tr>`,
    )
    .join('');
  return `
    <div class="metrics">
      <div>各对径实测差之和：<b>${fmt(details.diffSum)}</b> g</div>
      <div>冻结容差：<b>${fmt(result.tolerance)}</b> g</div>
    </div>
    <h3>逐孔实测明细（冻结）</h3>
    <table class="pair-list">
      <thead><tr><th>孔位</th><th>冻结图物件</th><th>实测</th><th>判定</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <h3>对径孔对判定（冻结）</h3>
    <table class="pair-list">
      <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>容差判定</th></tr></thead>
      <tbody>${pairsHtml}</tbody>
    </table>
    <details class="snapshot-block">
      <summary>冻结的原始实测条目</summary>
      <pre>${escapeHtml(JSON.stringify(entries, null, 2))}</pre>
    </details>`;
}

$('#verify-close').addEventListener('click', () => $('#verify-dialog').close());

// ---------- 启动 ----------

refresh().catch((e) => showAlert('初始化失败：' + e.message, 'err'));

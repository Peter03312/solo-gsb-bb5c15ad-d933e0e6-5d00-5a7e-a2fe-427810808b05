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
    throw new Error(list);
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

// ---------- 启动 ----------

refresh().catch((e) => showAlert('初始化失败：' + e.message, 'err'));

// ダッシュボード。エージェントの出力は信頼できない内容なので、DOMには必ず textContent で入れる。

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const PROJECT_STATUS = {
  planning: ['計画中', 'run'],
  awaiting_plan_approval: ['計画承認待ち', 'warn'],
  running: ['実行中', 'run'],
  paused: ['一時停止', 'warn'],
  done: ['完了', 'ok'],
  failed: ['失敗', 'bad'],
};
const TASK_STATUS = {
  pending: ['待機', ''],
  running: ['作業中', 'run'],
  reviewing: ['レビュー中', 'run'],
  awaiting_approval: ['承認待ち', 'warn'],
  done: ['完了', 'ok'],
  failed: ['失敗', 'bad'],
};
const CATEGORY = { decision: '意思決定', publish: '外部公開', cost: '費用' };
const APPROVAL_HINT = {
  plan: '承認すると実行を開始します。却下するとコメントを踏まえて再計画します。',
  task_gate: '承認すると完了します。却下するとコメントを踏まえて修正します。',
  quality_escalation: '承認すると現状のまま完了扱い、却下するとタスクを失敗にします。',
  budget: '承認すると予算を追加して続行します。',
  tool: '承認するとエージェントがこの操作を実行します。',
};

const ui = { state: null, events: [], files: null, filesSig: '', selected: localGet('selectedProject') };

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } }

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    $('login').hidden = false;
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

const roleName = (id) => ui.state?.roles.find((r) => r.id === id)?.name ?? id;
const chip = ([label, cls]) => h('span', { class: `chip ${cls}` }, label);
const time = (iso) => new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const usd = (n) => `$${n.toFixed(2)}`;

// ------------------------------------------------------------------ 描画

function render() {
  const s = ui.state;
  if (!s) return;
  renderApprovals(s);
  renderProjects(s);
  renderDetail(s);
}

function renderApprovals(s) {
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const badge = $('approvalCount');
  badge.textContent = pending.length;
  badge.classList.toggle('hot', pending.length > 0);
  document.title = pending.length ? `(${pending.length}) AI Agent Orchestrator` : 'AI Agent Orchestrator';

  const box = $('approvals');
  // 入力中のコメントを消さないよう、内容が変わったときだけ描き直す
  const sig = pending.map((a) => a.id).join(',');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(
    ...(pending.length ? pending.map(approvalCard) : [h('p', { class: 'empty' }, '承認待ちはありません')]),
  );
}

function approvalCard(a) {
  const project = ui.state.projects.find((p) => p.id === a.projectId);
  const comment = h('textarea', { placeholder: 'コメント(却下時は修正指示として渡されます)', rows: 2 });
  const decide = async (approve, btns) => {
    btns.forEach((b) => (b.disabled = true));
    try {
      await api(`/api/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ approve, comment: comment.value }) });
    } catch (e) {
      alert(`失敗しました: ${e.message}`);
      btns.forEach((b) => (b.disabled = false));
    }
  };
  const ok = h('button', { class: 'btn ok' }, '承認');
  const ng = h('button', { class: 'btn bad' }, '却下');
  ok.onclick = () => decide(true, [ok, ng]);
  ng.onclick = () => decide(false, [ok, ng]);
  return h('div', { class: 'card approval stack' },
    h('div', { class: 'row' }, h('span', { class: 'chip warn' }, CATEGORY[a.category]), h('strong', {}, a.title)),
    h('div', { class: 'meta' }, `${project?.name ?? ''} ・ 依頼: ${a.requestedBy === 'system' ? 'システム' : roleName(a.requestedBy)} ・ ${time(a.createdAt)}`),
    h('div', { class: 'pre' }, a.detail),
    h('div', { class: 'meta' }, APPROVAL_HINT[a.kind]),
    comment,
    h('div', { class: 'row end' }, ng, ok),
  );
}

function renderProjects(s) {
  const list = [...s.projects].reverse();
  $('projects').replaceChildren(
    ...(list.length ? list.map((p) => {
      const tasks = s.tasks.filter((t) => t.projectId === p.id);
      const done = tasks.filter((t) => t.status === 'done').length;
      return h('div', {
        class: `card selectable${p.id === ui.selected ? ' selected' : ''}`,
        onclick: () => select(p.id),
      },
        h('div', { class: 'row between' }, h('strong', {}, p.name), chip(PROJECT_STATUS[p.status])),
        h('div', { class: 'meta' }, `タスク ${done}/${tasks.length} ・ ${usd(p.spentUsd)} / ${usd(p.budgetUsd)}`),
      );
    }) : [h('p', { class: 'empty' }, 'まだプロジェクトがありません')]),
  );
}

function renderDetail(s) {
  const p = s.projects.find((x) => x.id === ui.selected);
  const box = $('detail');
  if (!p) {
    box.replaceChildren(h('p', { class: 'empty' }, 'プロジェクトを選択するか、新規作成してください。'));
    return;
  }
  const openDetails = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  const tasks = s.tasks.filter((t) => t.projectId === p.id);
  const bar = h('span');
  bar.style.width = `${(p.budgetUsd ? Math.min(p.spentUsd / p.budgetUsd, 1) : 1) * 100}%`;

  const header = h('div', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, p.name), chip(PROJECT_STATUS[p.status])),
    h('div', { class: 'pre' }, p.goal),
    h('div', { class: 'meta' }, `チーム: ${p.team.map(roleName).join('、')}`),
    h('div', {},
      h('div', { class: 'meta' }, `費用 ${usd(p.spentUsd)} / 予算 ${usd(p.budgetUsd)}`),
      h('div', { class: `budget${p.spentUsd >= p.budgetUsd ? ' over' : ''}` }, bar),
    ),
    p.planRationale && h('div', {}, h('strong', {}, '計画の判断理由: '), p.planRationale),
    p.status === 'failed' && h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => api(`/api/projects/${p.id}/retry`, { method: 'POST' }).catch((e) => alert(e.message)) }, '失敗箇所から再開'),
    ),
  );

  const board = h('div', { class: 'tasks' }, ...tasks.map((t) => taskCard(t, tasks, openDetails)));
  const files = h('div', { class: 'card files' }, h('h2', {}, '成果物'), h('div', { id: 'fileList' }, '読み込み中…'));
  const log = h('div', { class: 'card' }, h('h2', {}, '作業ログ'), h('div', { class: 'log', id: 'log' }));

  box.replaceChildren(header, tasks.length ? board : h('p', { class: 'empty' }, '計画を作成しています…'), files, log);
  renderLog();
  // 成果物はタスクの進行があったときだけ取り直す
  const sig = `${p.id}:${tasks.map((t) => `${t.status}${t.attempts.length}`).join()}`;
  if (sig !== ui.filesSig) {
    ui.filesSig = sig;
    ui.files = null;
    loadFiles(p.id);
  } else {
    showFiles(p.id);
  }
}

function taskCard(t, all, openDetails) {
  const last = t.attempts.at(-1);
  const deps = t.dependsOn.map((k) => all.find((x) => x.key === k)?.title ?? k);
  const attemptsKey = `${t.id}:attempts`;
  return h('div', { class: 'card task stack' },
    h('div', { class: 'row between' }, h('h3', {}, t.title), chip(TASK_STATUS[t.status])),
    h('div', { class: 'meta' },
      `担当: ${roleName(t.role)} ・ レビュー: ${t.reviewers.map(roleName).join('、')} ・ 試行 ${t.attempts.length}`,
      t.approval ? ` ・ ⚠ ${CATEGORY[t.approval.category]}承認` : ''),
    deps.length > 0 && h('div', { class: 'meta' }, `前工程: ${deps.join('、')}`),
    last?.summary && h('div', {}, last.summary),
    last?.rationale && h('div', { class: 'meta' }, `判断理由: ${last.rationale}`),
    last?.error && h('div', { class: 'error' }, last.error),
    t.attempts.length > 0 && h('details', { 'data-key': attemptsKey, open: openDetails.has(attemptsKey) },
      h('summary', {}, 'レビューと修正の履歴'),
      ...t.attempts.map((a) => h('div', { class: 'review' },
        h('strong', {}, `試行 ${a.n}`), ` ・ ${usd(a.costUsd)}`,
        a.error && h('div', { class: 'error' }, a.error),
        ...a.reviews.map((r) => h('div', {},
          chip(r.verdict === 'pass' ? ['合格', 'ok'] : ['差し戻し', 'bad']), ` ${roleName(r.reviewer)} ${r.score}点 — ${r.rationale}`,
          r.issues.length > 0 && h('ul', { class: 'tight' }, ...r.issues.map((i) => h('li', {}, i))),
          r.rootCause && h('div', { class: 'meta' }, `原因: ${r.rootCause}`),
          r.suggestions.length > 0 && h('div', { class: 'meta' }, `修正案: ${r.suggestions.join(' / ')}`),
        )),
      )),
    ),
    t.humanFeedback && h('div', { class: 'meta' }, `人間の指示: ${t.humanFeedback}`),
  );
}

function renderLog() {
  const box = $('log');
  if (!box) return;
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const tasks = ui.state.tasks;
  box.replaceChildren(...ui.events.slice(-200).map((e) => h('div', { class: `entry kind-${e.kind}` },
    h('time', {}, time(e.ts)),
    h('span', { class: 'who' }, e.agent === 'human' ? '人間' : e.agent === 'system' ? 'システム' : roleName(e.agent)),
    h('span', {}, e.taskId ? `[${tasks.find((t) => t.id === e.taskId)?.title ?? ''}] ` : '', e.message),
  )));
  if (stick) box.scrollTop = box.scrollHeight;
}

async function loadFiles(projectId) {
  try {
    ui.files = await api(`/api/projects/${projectId}/files`);
    showFiles(projectId);
  } catch (e) {
    const box = $('fileList');
    if (box) box.textContent = e.message;
  }
}

function showFiles(projectId) {
  const box = $('fileList');
  const files = ui.files;
  if (!box || !files) return;
  box.replaceChildren(...(files.length
      ? [h('ul', { class: 'tight' }, ...files.map((f) => h('li', {},
          h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openFile(projectId, f.path); } }, f.path),
          h('span', { class: 'meta' }, ` ${(f.size / 1024).toFixed(1)} KB`))))]
      : [h('span', { class: 'empty' }, 'まだありません')]));
}

async function openFile(projectId, path) {
  $('fileTitle').textContent = path;
  $('fileBody').textContent = '読み込み中…';
  $('fileViewer').showModal();
  try {
    $('fileBody').textContent = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
  } catch (e) {
    $('fileBody').textContent = `表示できません: ${e.message}`;
  }
}

// ------------------------------------------------------------------ データ

async function select(id) {
  ui.selected = id;
  localSet('selectedProject', id);
  ui.events = await api(`/api/events?projectId=${id}`);
  render();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

async function refresh() {
  ui.state = await api('/api/state');
  render();
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => $('conn').classList.add('live'));
  es.addEventListener('error', () => $('conn').classList.remove('live'));
  es.addEventListener('change', scheduleRefresh);
  es.addEventListener('log', (ev) => {
    const e = JSON.parse(ev.data);
    if (e.projectId !== ui.selected) return;
    ui.events.push(e);
    if (ui.events.length > 500) ui.events.shift();
    renderLog();
  });
}

// ------------------------------------------------------------------ 新規プロジェクト

function openNewProject() {
  const choices = $('teamChoices');
  choices.replaceChildren(...ui.state.roles.map((r) => {
    const fixed = r.id === 'director' || r.id === 'qa_reviewer';
    return h('label', {}, h('input', { type: 'checkbox', name: 'team', value: r.id, checked: true, disabled: fixed }), r.name);
  }));
  $('newProjectError').hidden = true;
  $('newProject').showModal();
}

async function submitNewProject(ev) {
  ev.preventDefault();
  const form = ev.target;
  const data = new FormData(form);
  const team = [...form.querySelectorAll('input[name=team]:checked')].map((i) => i.value);
  try {
    const project = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: data.get('name'), goal: data.get('goal'), budgetUsd: Number(data.get('budgetUsd')), team }),
    });
    $('newProject').close();
    form.reset();
    await refresh();
    await select(project.id);
  } catch (e) {
    $('newProjectError').textContent = e.message;
    $('newProjectError').hidden = false;
  }
}

// ------------------------------------------------------------------ 起動

document.addEventListener('DOMContentLoaded', async () => {
  $('newProjectBtn').addEventListener('click', openNewProject);
  $('newProjectForm').addEventListener('submit', submitNewProject);
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }
  try {
    await refresh();
    if (ui.selected && ui.state.projects.some((p) => p.id === ui.selected)) await select(ui.selected);
    connect();
  } catch {
    // 未ログイン時はオーバーレイを表示済み
  }
});

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
  business_budget: '承認すると、この事業のプロジェクトはすべて今月に限り月予算を超えて続行します。同じ事業の承認待ちもまとめて片付きます(却下も同様)。',
  tool: '承認するとエージェントがこの操作を実行します。',
};

const ui = { state: null, events: [], files: null, filesSig: '', selected: localGet('selectedProject'), showArchived: false, page: null };
const ROLE_FIELD_LABEL = { name: '名前', mission: '使命', criteria: '判断基準', tools: 'ツール', provider: 'AIサービス', model: 'モデル', effort: '思考レベル' };
const ROLE_ACTION = { create: ['追加', 'run'], update: ['変更', ''], reset: ['初期値に戻す', 'warn'], delete: ['削除', 'bad'] };
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: 'とても高い', max: '最大' };

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
const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ja-JP'));
const date = (iso) => new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
const openBusinesses = () => ui.state.businesses.filter((b) => !b.archivedAt);
const businessOf = (p) => ui.state.businesses.find((b) => b.id === p?.businessId);
const projectMonthSpend = (p) => p.spendByMonth?.[ui.state.month] ?? 0;
const ACTIVE = new Set(['planning', 'awaiting_plan_approval', 'running', 'paused']);

function budgetBar(spent, budget) {
  const bar = h('span');
  bar.style.width = `${(budget ? Math.min(spent / budget, 1) : 0) * 100}%`;
  return h('div', { class: `budget${budget && spent >= budget ? ' over' : ''}` }, bar);
}

/** 事業ごと(事業なしは最後)にプロジェクトをまとめる。 */
function groupByBusiness(projects) {
  const groups = ui.state.businesses.map((b) => ({ business: b, projects: projects.filter((p) => p.businessId === b.id) }));
  const loose = projects.filter((p) => !businessOf(p));
  if (loose.length) groups.push({ business: null, projects: loose });
  return groups;
}

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
  const sig = pending.map((a) => {
    const p = s.projects.find((x) => x.id === a.projectId);
    return `${a.id}:${businessOf(p)?.name ?? ''}`;
  }).join(',');
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
    h('div', { class: 'meta' }, `${businessOf(project)?.name ? `${businessOf(project).name} / ` : ''}${project?.name ?? ''} ・ 依頼: ${a.requestedBy === 'system' ? 'システム' : roleName(a.requestedBy)} ・ ${time(a.createdAt)}`),
    h('div', { class: 'pre' }, a.detail),
    h('div', { class: 'meta' }, APPROVAL_HINT[a.kind]),
    comment,
    h('div', { class: 'row end' }, ng, ok),
  );
}

function renderProjects(s) {
  if (!s.projects.length) {
    $('projects').replaceChildren(h('p', { class: 'empty' }, 'まだプロジェクトがありません'));
    return;
  }
  const card = (p) => {
    const tasks = s.tasks.filter((t) => t.projectId === p.id);
    const done = tasks.filter((t) => t.status === 'done').length;
    return h('div', {
      class: `card selectable${p.id === ui.selected ? ' selected' : ''}`,
      onclick: () => select(p.id),
    },
      h('div', { class: 'row between' }, h('strong', {}, p.name), chip(PROJECT_STATUS[p.status])),
      h('div', { class: 'meta' }, `タスク ${done}/${tasks.length} ・ ${usd(p.spentUsd)} / ${usd(p.budgetUsd)}`),
    );
  };
  $('projects').replaceChildren(...groupByBusiness([...s.projects].reverse())
    .filter((g) => g.projects.length)
    .flatMap((g) => [h('h3', { class: 'group-title' }, g.business ? `${g.business.name}${g.business.archivedAt ? '(アーカイブ中)' : ''}` : '事業なし'), ...g.projects.map(card)]));
}

function renderRoles(s, box) {
  const modelLabel = (id) => s.choices.models.find((m) => m.id === (id ?? ''))?.label ?? id;
  const toolLabel = (id) => s.choices.tools.find((t) => t.id === id)?.label ?? id;
  const cards = s.roles.map((r) => {
    const inBiz = s.businesses.filter((b) => b.team.includes(r.id)).length;
    const inProj = s.projects.filter((p) => p.team.includes(r.id)).length;
    return h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h2', {}, r.name), chip(r.builtin ? ['標準', ''] : ['追加', 'run'])),
      h('div', {}, r.mission),
      h('div', {}, h('strong', {}, '判断基準'), h('ul', {}, ...r.criteria.map((c) => h('li', {}, c)))),
      h('div', { class: 'counts' },
        chip([modelLabel(r.model), '']),
        chip([`思考: ${EFFORT_LABEL[r.effort ?? 'medium']}${r.effort ? '' : '(既定)'}`, '']),
        chip([r.provider, '']),
        !r.tools.includes('Write') && chip(['レビュー専任', 'warn'])),
      h('div', { class: 'meta' }, `ツール: ${r.tools.map(toolLabel).join('、') || 'なし'}`),
      h('div', { class: 'row between' },
        h('span', { class: 'meta' }, `使用中: 事業 ${inBiz} ・ プロジェクト ${inProj}`),
        h('button', { class: 'btn', onclick: () => openRole(r) }, '編集')),
    );
  });
  box.replaceChildren(
    h('div', { class: 'card stack' },
      h('div', { class: 'row between' },
        h('button', { class: 'btn', onclick: () => select(null) }, '← 全体'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => document.getElementById('roleHistory')?.scrollIntoView({ behavior: 'smooth' }) }, `変更履歴 (${s.roleHistory.length})`),
          h('button', { class: 'btn primary', onclick: () => openRole() }, '＋ 役割を追加'))),
      h('h2', {}, '役割と判断基準'),
      h('p', { class: 'meta' }, '変更は次の作業から反映されます(作業中のAIには影響しません)。外部公開・費用・危険なコマンドの承認ルールは、役割の設定に関係なく常に有効です。')),
    h('div', { class: 'roles' }, ...cards),
    roleHistoryView(s));
}

function roleHistoryView(s) {
  const modelLabel = (id) => (id ? s.choices.models.find((m) => m.id === id)?.label ?? id : '既定');
  const show = (field, v) => {
    if (field === 'model') return modelLabel(v);
    if (field === 'effort') return v ? EFFORT_LABEL[v] : '既定';
    return v || '(なし)';
  };
  const change = (c) => {
    if (c.field === 'criteria') {
      const before = c.before ? c.before.split('\n') : [];
      const after = c.after ? c.after.split('\n') : [];
      return h('div', {}, h('strong', {}, '判断基準'),
        h('ul', { class: 'tight' },
          ...before.filter((x) => !after.includes(x)).map((x) => h('li', { class: 'diff-del' }, `− ${x}`)),
          ...after.filter((x) => !before.includes(x)).map((x) => h('li', { class: 'diff-add' }, `＋ ${x}`))));
    }
    return h('div', {}, h('strong', {}, ROLE_FIELD_LABEL[c.field] ?? c.field), `: ${show(c.field, c.before)} → ${show(c.field, c.after)}`);
  };
  const entries = [...s.roleHistory].reverse().slice(0, 100);
  return h('div', { class: 'card stack', id: 'roleHistory' },
    h('h2', {}, '変更履歴'),
    entries.length
      ? h('div', { class: 'stack' }, ...entries.map((e) => h('div', { class: 'review' },
          h('div', { class: 'row' },
            chip(ROLE_ACTION[e.action]),
            h('strong', {}, e.roleName),
            h('span', { class: 'meta' }, new Date(e.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))),
          e.action === 'update' || e.action === 'reset' ? e.changes.map(change) : null)))
      : h('p', { class: 'empty' }, 'まだ変更はありません'),
    s.roleHistory.length > 100 && h('p', { class: 'meta' }, `新しい100件を表示しています(全${s.roleHistory.length}件)`));
}

function kpiView(k) {
  const ratio = k.target ? k.current / k.target : null;
  return h('div', { class: 'kpi' },
    h('div', { class: 'row' },
      h('span', {}, k.name),
      h('span', { class: 'value' }, `${num(k.current)}${k.unit}`, k.target !== null && h('span', { class: 'meta' }, ` / 目標 ${num(k.target)}${k.unit}`))),
    k.target ? budgetBarPlain(ratio) : null,
    h('div', { class: 'meta' }, `${ratio !== null && k.current !== null ? `達成率 ${Math.round(ratio * 100)}% ・ ` : ''}更新 ${date(k.updatedAt)}`));
}

function budgetBarPlain(ratio) {
  const bar = h('span');
  bar.style.width = `${Math.max(0, Math.min(ratio ?? 0, 1)) * 100}%`;
  return h('div', { class: 'budget' }, bar);
}

function renderOverview(s, box) {
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const monthTotal = s.projects.reduce((sum, p) => sum + projectMonthSpend(p), 0);
  const stat = (label, value) => h('div', { class: 'card' }, h('div', { class: 'meta' }, label), h('div', { class: 'stat' }, value));
  const summary = h('div', { class: 'summary' },
    stat('事業', openBusinesses().length),
    stat('進行中のプロジェクト', s.projects.filter((p) => ACTIVE.has(p.status)).length),
    stat('承認待ち', pending.length),
    stat(`今月の費用 (${s.month})`, usd(monthTotal)),
  );

  const archivedCount = s.businesses.filter((b) => b.archivedAt).length;
  const groups = groupByBusiness(s.projects).filter((g) => ui.showArchived || !g.business?.archivedAt);
  const cards = groups.map(({ business: b, projects }) => {
    const count = (st) => projects.filter((p) => st.includes(p.status)).length;
    const approvalsHere = pending.filter((a) => projects.some((p) => p.id === a.projectId)).length;
    const spent = projects.reduce((sum, p) => sum + projectMonthSpend(p), 0);
    const ordered = [...projects].sort((x, y) => Number(ACTIVE.has(y.status)) - Number(ACTIVE.has(x.status)) || y.updatedAt.localeCompare(x.updatedAt));
    return h('div', { class: `card stack${b?.archivedAt ? ' archived' : ''}` },
      h('div', { class: 'row between' },
        h('h2', {}, b?.name ?? '事業なし'),
        b?.archivedAt ? chip(['アーカイブ中', '']) : approvalsHere > 0 && h('span', { class: 'badge hot' }, `承認待ち ${approvalsHere}`)),
      b?.description && h('div', { class: 'meta pre' }, b.description),
      h('div', {},
        h('div', { class: 'meta' }, b?.monthlyBudgetUsd ? `今月 ${usd(spent)} / 月予算 ${usd(b.monthlyBudgetUsd)}` : `今月 ${usd(spent)}${b ? '(月予算なし)' : ''}`),
        b?.monthlyBudgetUsd && budgetBar(spent, b.monthlyBudgetUsd)),
      b?.kpis.length > 0 && h('div', { class: 'kpis' }, ...b.kpis.map(kpiView)),
      h('div', { class: 'counts' },
        chip([`進行中 ${count(['planning', 'running'])}`, 'run']),
        chip([`承認待ち・停止 ${count(['awaiting_plan_approval', 'paused'])}`, 'warn']),
        chip([`完了 ${count(['done'])}`, 'ok']),
        chip([`失敗 ${count(['failed'])}`, 'bad'])),
      ordered.length
        ? h('div', { class: 'plist' }, ...ordered.slice(0, 6).map((p) => h('button', { onclick: () => select(p.id) }, h('span', {}, p.name), chip(PROJECT_STATUS[p.status]))),
            ordered.length > 6 && h('div', { class: 'meta' }, `ほか ${ordered.length - 6} 件(左の一覧から選べます)`))
        : h('p', { class: 'empty' }, 'プロジェクトはまだありません'),
      b && !b.archivedAt && h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => archiveBusiness(b, true) }, 'アーカイブ'),
        h('button', { class: 'btn', onclick: () => openBusiness(b) }, '編集'),
        h('button', { class: 'btn primary', onclick: () => openNewProject(b.id) }, '＋ プロジェクト')),
      b?.archivedAt && h('div', { class: 'row end' },
        projects.length
          ? h('span', { class: 'meta' }, 'プロジェクトがあるため削除できません')
          : h('button', { class: 'btn bad', onclick: () => deleteBusiness(b) }, '削除'),
        h('button', { class: 'btn', onclick: () => archiveBusiness(b, false) }, '元に戻す')),
    );
  });
  const archivedToggle = archivedCount > 0 && h('div', { class: 'row end' },
    h('button', { class: 'btn', onclick: () => { ui.showArchived = !ui.showArchived; render(); } },
      ui.showArchived ? 'アーカイブ済みを隠す' : `アーカイブ済みの事業を表示 (${archivedCount})`));

  box.replaceChildren(summary,
    cards.length ? h('div', { class: 'stack' }, h('div', { class: 'businesses' }, ...cards), archivedToggle)
      : h('div', { class: 'card stack' },
          h('p', {}, '事業を作ると、プロジェクトを事業ごとにまとめて、進み具合・承認待ち・今月の費用を一覧できます。'),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => openBusiness() }, '＋ 最初の事業を作る'))));
}

function renderDetail(s) {
  const box = $('detail');
  if (ui.page === 'roles') {
    renderRoles(s, box);
    return;
  }
  const p = s.projects.find((x) => x.id === ui.selected);
  if (!p) {
    renderOverview(s, box);
    return;
  }
  const openDetails = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  const tasks = s.tasks.filter((t) => t.projectId === p.id);
  const header = h('div', { class: 'card stack' },
    h('div', { class: 'row between' },
      h('button', { class: 'btn', onclick: () => select(null) }, '← 全体'),
      moveSelect(p)),
    h('div', { class: 'row between' }, h('h2', {}, p.name), chip(PROJECT_STATUS[p.status])),
    h('div', { class: 'pre' }, p.goal),
    h('div', { class: 'meta' }, `チーム: ${p.team.map(roleName).join('、')}`),
    h('div', {},
      h('div', { class: 'meta' }, `費用 ${usd(p.spentUsd)} / 予算 ${usd(p.budgetUsd)}`),
      budgetBar(p.spentUsd, p.budgetUsd),
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

function moveSelect(p) {
  const current = businessOf(p);
  const options = [
    h('option', { value: '', selected: !current }, '事業なし'),
    ...ui.state.businesses
      .filter((b) => !b.archivedAt || b.id === current?.id)
      .map((b) => h('option', { value: b.id, selected: b.id === current?.id }, b.name + (b.archivedAt ? '(アーカイブ中)' : ''))),
  ];
  const sel = h('select', { 'aria-label': '事業' }, ...options);
  sel.onchange = async () => {
    const to = ui.state.businesses.find((b) => b.id === sel.value);
    if (!confirm(`「${p.name}」を「${to?.name ?? '事業なし'}」へ移しますか?費用の集計も一緒に移ります。`)) {
      sel.value = current?.id ?? '';
      return;
    }
    try {
      await api(`/api/projects/${p.id}/move`, { method: 'POST', body: JSON.stringify({ businessId: sel.value || null }) });
    } catch (e) {
      alert(e.message);
      sel.value = current?.id ?? '';
    }
  };
  return h('label', { class: 'move meta' }, '事業:', sel);
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

/** id を null にすると全体画面に戻る。 */
async function select(id) {
  ui.page = null;
  ui.selected = id;
  localSet('selectedProject', id ?? '');
  ui.events = id ? await api(`/api/events?projectId=${id}`) : [];
  render();
  window.scrollTo({ top: 0 });
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

function teamCheckboxes(box, selected) {
  box.replaceChildren(...ui.state.roles.map((r) => {
    const fixed = r.id === 'director' || r.id === 'qa_reviewer';
    return h('label', {}, h('input', { type: 'checkbox', name: 'team', value: r.id, checked: fixed || selected.includes(r.id), disabled: fixed }), r.name);
  }));
}

function openNewProject(businessId) {
  const select = $('projectBusiness');
  const current = typeof businessId === 'string' ? businessId : businessOf(ui.state.projects.find((p) => p.id === ui.selected))?.id ?? '';
  select.replaceChildren(h('option', { value: '' }, '事業なし'),
    ...openBusinesses().map((b) => h('option', { value: b.id, selected: b.id === current }, b.name)));
  const applyTeam = () => {
    const b = ui.state.businesses.find((x) => x.id === select.value);
    teamCheckboxes($('teamChoices'), b ? b.team : ui.state.roles.map((r) => r.id));
  };
  select.onchange = applyTeam;
  applyTeam();
  $('newProjectError').hidden = true;
  $('newProject').showModal();
}

function openBusiness(b) {
  const form = $('businessForm');
  form.reset();
  form.elements.id.value = b?.id ?? '';
  form.elements.name.value = b?.name ?? '';
  form.elements.description.value = b?.description ?? '';
  form.elements.monthlyBudgetUsd.value = b?.monthlyBudgetUsd ?? '';
  $('businessDialogTitle').textContent = b ? '事業の編集' : '新規事業';
  teamCheckboxes($('businessTeamChoices'), b ? b.team : ui.state.roles.map((r) => r.id));
  $('kpiRows').replaceChildren(...(b?.kpis ?? []).map(kpiRow));
  $('businessError').hidden = true;
  $('businessDialog').showModal();
}

function kpiRow(k = {}) {
  const field = (label, name, attrs) => h('label', {}, label, h('input', { name, value: k[name] ?? '', ...attrs }));
  const row = h('div', { class: 'kpi-row', 'data-id': k.id ?? '' },
    field('指標名', 'kname', { value: k.name ?? '', placeholder: '例: 月間売上', maxlength: 60 }),
    field('現在値', 'current', { type: 'number', step: 'any' }),
    field('目標', 'target', { type: 'number', step: 'any' }),
    field('単位', 'unit', { placeholder: '円', maxlength: 10 }),
  );
  row.append(h('button', { type: 'button', class: 'btn', 'aria-label': 'このKPIを削除', onclick: () => row.remove() }, '×'));
  return row;
}

function readKpis() {
  return [...$('kpiRows').children].map((row) => {
    const v = (n) => row.querySelector(`[name=${n}]`).value;
    const n = (x) => (x === '' ? null : Number(x));
    return { id: row.dataset.id || undefined, name: v('kname'), unit: v('unit'), current: n(v('current')), target: n(v('target')) };
  }).filter((k) => k.name.trim() || k.current !== null || k.target !== null);
}

async function archiveBusiness(b, archived) {
  if (archived && !confirm(`「${b.name}」をアーカイブしますか?一覧から隠れ、新しいプロジェクトは作れなくなります(進行中のプロジェクトは続きます)。いつでも元に戻せます。`)) return;
  try {
    await api(`/api/businesses/${b.id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) });
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}

async function deleteBusiness(b) {
  if (!confirm(`「${b.name}」を削除しますか?この操作は元に戻せません。`)) return;
  try {
    await api(`/api/businesses/${b.id}`, { method: 'DELETE' });
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}

function showRoles() {
  ui.page = 'roles';
  render();
  window.scrollTo({ top: 0 });
}

function fillSelect(sel, options, value) {
  sel.replaceChildren(...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function openRole(r) {
  const c = ui.state.choices;
  const form = $('roleForm');
  form.reset();
  form.elements.id.value = r?.id ?? '';
  form.elements.name.value = r?.name ?? '';
  form.elements.mission.value = r?.mission ?? '';
  form.elements.criteria.value = (r?.criteria ?? []).join('\n');
  fillSelect(form.elements.provider, c.providers.map((p) => [p, p]), r?.provider ?? 'claude-code');
  fillSelect(form.elements.model, c.models.map((m) => [m.id, m.label]), r?.model ?? '');
  fillSelect(form.elements.effort, [['', '既定(中)'], ...c.efforts.map((e) => [e, EFFORT_LABEL[e]])], r?.effort ?? '');
  const tools = r?.tools ?? ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  $('roleToolChoices').replaceChildren(...c.tools.map((t) =>
    h('label', {}, h('input', { type: 'checkbox', name: 'tools', value: t.id, checked: tools.includes(t.id) }), t.label)));
  $('roleDialogTitle').textContent = r ? `役割の編集: ${r.name}` : '役割の追加';
  $('roleDeleteBtn').hidden = !r || r.builtin;
  $('roleResetBtn').hidden = !r?.builtin;
  $('roleError').hidden = true;
  $('roleDialog').showModal();
}

async function roleAction(fn) {
  try {
    await fn();
    $('roleDialog').close();
    await refresh();
  } catch (e) {
    $('roleError').textContent = e.message;
    $('roleError').hidden = false;
  }
}

function submitRole(ev) {
  ev.preventDefault();
  const form = ev.target;
  const id = form.elements.id.value;
  const body = {
    name: form.elements.name.value,
    mission: form.elements.mission.value,
    criteria: form.elements.criteria.value.split('\n'),
    provider: form.elements.provider.value,
    model: form.elements.model.value,
    effort: form.elements.effort.value,
    tools: [...form.querySelectorAll('input[name=tools]:checked')].map((i) => i.value),
  };
  roleAction(() => api(id ? `/api/roles/${id}` : '/api/roles', { method: 'POST', body: JSON.stringify(body) }));
}

async function submitBusiness(ev) {
  ev.preventDefault();
  const form = ev.target;
  const id = form.elements.id.value;
  const budget = form.elements.monthlyBudgetUsd.value;
  const body = {
    name: form.elements.name.value,
    description: form.elements.description.value,
    monthlyBudgetUsd: budget === '' ? null : Number(budget),
    team: [...form.querySelectorAll('input[name=team]:checked')].map((i) => i.value),
    kpis: readKpis(),
  };
  try {
    await api(id ? `/api/businesses/${id}` : '/api/businesses', { method: 'POST', body: JSON.stringify(body) });
    $('businessDialog').close();
    await refresh();
  } catch (e) {
    $('businessError').textContent = e.message;
    $('businessError').hidden = false;
  }
}

async function submitNewProject(ev) {
  ev.preventDefault();
  const form = ev.target;
  const data = new FormData(form);
  const team = [...form.querySelectorAll('input[name=team]:checked')].map((i) => i.value);
  try {
    const project = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ businessId: data.get('businessId') || undefined, name: data.get('name'), goal: data.get('goal'), budgetUsd: Number(data.get('budgetUsd')), team }),
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
  $('newProjectBtn').addEventListener('click', () => openNewProject());
  $('newProjectForm').addEventListener('submit', submitNewProject);
  $('newBusinessBtn').addEventListener('click', () => openBusiness());
  $('businessForm').addEventListener('submit', submitBusiness);
  $('overviewBtn').addEventListener('click', () => select(null));
  $('addKpiBtn').addEventListener('click', () => $('kpiRows').append(kpiRow()));
  $('rolesBtn').addEventListener('click', showRoles);
  $('roleForm').addEventListener('submit', submitRole);
  $('roleResetBtn').addEventListener('click', () => {
    const id = $('roleForm').elements.id.value;
    if (confirm('この役割を初期値に戻しますか?編集した内容は失われます。')) roleAction(() => api(`/api/roles/${id}/reset`, { method: 'POST' }));
  });
  $('roleDeleteBtn').addEventListener('click', () => {
    const id = $('roleForm').elements.id.value;
    if (confirm('この役割を削除しますか?')) roleAction(() => api(`/api/roles/${id}`, { method: 'DELETE' }));
  });
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

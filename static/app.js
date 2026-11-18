/* TaskFlow front-end (vanilla JS, no build step). */
(() => {
'use strict';

// ---------------------------------------------------------------- utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSRF = $('meta[name=csrf-token]').content;
const PRIORITIES = { 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Urgent' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b || {});
const PATCH = (u, b) => api('PATCH', u, b);
const DEL = (u) => api('DELETE', u);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDateTime = (iso) => { const d = new Date(iso); return `${fmtDay(d)}, ${fmtTime(d)}`; };
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? `${h}:${pad(m)}` : pad(m)) + ':' + pad(s % 60); };
const minToTime = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const timeToMin = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); };
const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60 ? (min % 60) + 'm' : ''}`.trim() : `${min}m`);

function toast(msg, type = 'ok', action) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 9000 : 4500);
  return el;
}
const fail = (e) => toast(e.message || String(e), 'err');

async function runCopilot(message) {
  const input=$('#copilot-input'), out=$('#copilot-output');
  if(!message||!out)return;
  if(input)input.disabled=true;
  const sendButton=$('#copilot-form button[type="submit"]');
  if(sendButton)sendButton.disabled=true;
  const userMessage=document.createElement('div');
  userMessage.className='chat-message user-message';
  userMessage.textContent=message;
  out.appendChild(userMessage);
  const response=document.createElement('div');
  response.className='chat-message assistant-message';
  response.setAttribute('aria-live','polite');
  response.textContent='Copilot is working…';
  out.appendChild(response);
  out.scrollTop=out.scrollHeight;
  try {
    const result=await TaskFlowAgent.send(message);
    for(const c of result.changes||[]){if(c.op==='create')await TaskStore.create(c.task);else if(c.op==='update')await TaskStore.update(c.id,c.fields);}
    response.textContent=result.reply||'Done';
    if(result.confirmations?.length){
      const confirmation=document.createElement('div');
      confirmation.className='chat-confirmation';
      confirmation.innerHTML=`<strong>Confirm deletion of ${result.confirmations.length} task(s)?</strong><ul>${result.confirmations.map(x=>`<li>${esc(x.title)}</li>`).join('')}</ul><div class="row"><button class="btn danger" type="button" data-confirm-delete>Confirm</button><button class="btn" type="button" data-cancel-delete>Cancel</button></div>`;
      response.appendChild(confirmation);
      confirmation.querySelector('[data-confirm-delete]').onclick=async()=>{try{await TaskFlowAgent.confirmDeletions(result.confirmations);confirmation.textContent='Deletion confirmed and applied.';}catch(err){fail(err);}};
      confirmation.querySelector('[data-cancel-delete]').onclick=()=>{confirmation.textContent='Deletion cancelled.';};
    }
    if(input){input.value='';input.style.height='';}
    out.scrollTop=out.scrollHeight;
    refreshBadge();
  } catch(err){response.textContent=err.message||'Copilot request failed.';response.classList.add('chat-error');} finally {if(input)input.disabled=false;if(sendButton)sendButton.disabled=false;}
}

// ---------------------------------------------------------------- state
const S = {
  user: null, projects: [], ai: { enabled: false }, view: 'dashboard',
  filters: { q: '', status: 'open', project: '', priority: '', due: '', sort: 'smart' },
  selectMode: false, selected: new Set(), trash: false,
  cal: { y: new Date().getFullYear(), m: new Date().getMonth(), sel: dayKey(new Date()), mode: 'month' },
  boardProject: '',
};
const projectName = (id) => (S.projects.find((p) => p.id === id) || {}).name;
const projectColor = (id) => (S.projects.find((p) => p.id === id) || {}).color || '#8b7cf6';
const projectOptions = (sel, withNone = 'No project') =>
  `<option value="">${esc(withNone)}</option>` + S.projects.map((p) => `<option value="${p.id}" ${String(sel) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

// ---------------------------------------------------------------- task rendering
const startOfDayMs = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function relDay(d) {
  const diff = Math.round((startOfDayMs(d) - startOfDayMs(new Date())) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : fmtDay(d);
}
function dueChip(t) {
  if (!t.due_at) return '';
  const d = new Date(t.due_at), now = new Date();
  if (Number.isNaN(d.getTime())) return '';
  let cls = 'due';
  if (t.status !== 'done') { if (d < now) cls += ' late'; else if (d - now < 86400000) cls += ' soon'; }
  const label = `${relDay(d)} · ${fmtTime(d)}`;
  return `<span class="chip ${cls}" title="Due ${esc(fmtDateTime(t.due_at))}">${cls.includes('late') ? 'Overdue · ' : ''}${esc(label)}</span>`;
}

const ICONS = {
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9.5 2.5h5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  next: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  prev: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
const iconBtn = (act, t, name, label, cls = '') =>
  `<button type="button" class="icon-btn ${cls}" data-act="${act}" data-id="${t.id}" title="${esc(label)}" aria-label="${esc(`${label}: ${t.title}`)}">${icon(name)}</button>`;
const MAX_TAGS = 3;

function inferredChip(t) {
  if (t.due_at) return '';
  const info = TaskStore.dateInfo(t);
  if (info.source !== 'text' && info.source !== 'sequence') return '';
  const d = new Date(info.time);
  const why = info.source === 'sequence' ? `Estimated from its ${info.kind} number in the series` : 'Detected from the task text';
  return `<span class="chip inferred" title="${why}; set a due date to make it exact">≈ ${esc(relDay(d))}</span>`;
}

const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done' };
function taskMeta(t) {
  const bits = [dueChip(t), inferredChip(t)];
  if (t.priority >= 3 && t.status !== 'done') bits.push(`<span class="chip prio p${t.priority}">${PRIORITIES[t.priority]}</span>`);
  if (t.project_id && projectName(t.project_id)) bits.push(`<span class="chip" style="background:${esc(projectColor(t.project_id))}33">📁 ${esc(projectName(t.project_id))}</span>`);
  if (t.estimate_min) bits.push(`<span class="chip">⏳ ${hm(t.estimate_min)}${t.logged_min ? ` · ${hm(t.logged_min)} logged` : ''}</span>`);
  else if (t.logged_min) bits.push(`<span class="chip">⏱ ${hm(t.logged_min)} logged</span>`);
  if (t.recurrence && t.recurrence !== 'none') bits.push(`<span class="chip">🔁 ${esc(t.recurrence)}</span>`);
  const tags = t.tags || [];
  tags.slice(0, MAX_TAGS).forEach((g) => bits.push(`<span class="chip tag">#${esc(g)}</span>`));
  if (tags.length > MAX_TAGS) bits.push(`<span class="chip tag more" title="${esc(tags.slice(MAX_TAGS).map((g) => '#' + g).join(' '))}">+${tags.length - MAX_TAGS}</span>`);
  return bits.filter(Boolean).join('');
}

function stepsProgress(t) {
  const subs = t.subtasks || [];
  if (!subs.length) return '';
  const done = subs.filter((s) => s.status === 'done').length, pct = Math.round((done / subs.length) * 100);
  return `<div class="steps" title="${done} of ${subs.length} steps done"><div class="steps-bar"><span style="width:${pct}%"></span></div><span>${done}/${subs.length} steps</span></div>`;
}

// One action bar for every task card (list and board), so the same control always does the same thing.
const STATUS_MOVES = {
  todo: [['doing', 'next', 'Start', 'Move to In progress'], ['done', 'check', '', 'Mark as done']],
  doing: [['todo', 'prev', '', 'Move back to To do'], ['done', 'check', 'Done', 'Mark as done']],
  done: [['todo', 'undo', 'Reopen', 'Move back to To do']],
};
function cardActions(t) {
  if (S.trash) return `<div class="card-actions"><div class="t-actions"><button class="btn small" data-act="restore" data-id="${t.id}">Restore</button><button class="btn small danger" data-act="purge" data-id="${t.id}">Delete forever</button></div></div>`;
  const moves = (STATUS_MOVES[t.status] || STATUS_MOVES.todo).map(([to, ico, label, hint]) =>
    `<button type="button" class="move-btn ${to === 'done' ? 'go' : ''} ${label ? '' : 'icon-only-move'}" data-act="move" data-v="${to}" data-id="${t.id}" title="${hint}" aria-label="${esc(`${hint}: ${t.title}`)}">${icon(ico)}${label ? `<span>${label}</span>` : ''}</button>`).join('');
  const tools = (t.status !== 'done' ? iconBtn('focus-task', t, 'timer', 'Start focus session') : '')
    + iconBtn('edit', t, 'edit', 'Edit task')
    + iconBtn('del', t, 'trash', 'Delete task', 'danger');
  return `<div class="card-actions"><div class="k-move" role="group" aria-label="Change status">${moves}</div><div class="t-actions" role="group" aria-label="Task tools">${tools}</div></div>`;
}

function taskRow(t) {
  const subs = (t.subtasks || []).map((s) => `
    <label class="${s.status === 'done' ? 'done' : ''}"><input type="checkbox" data-act="toggle" data-id="${s.id}" ${s.status === 'done' ? 'checked' : ''}><span>${esc(s.title)}</span></label>`).join('');
  const box = S.selectMode ? `<div class="t-check"><input type="checkbox" data-act="select" data-id="${t.id}" ${S.selected.has(t.id) ? 'checked' : ''} aria-label="Select ${esc(t.title)}"></div>` : '';
  const status = t.status === 'doing' && !S.trash ? `<span class="chip status doing">In progress</span>` : '';
  const meta = status + taskMeta(t);
  return `<article class="task row-card p${t.priority} ${t.status === 'done' ? 'done' : ''} ${S.selectMode ? 'selecting' : ''}" data-task="${t.id}">
    ${box}
    <div class="t-body"><div class="t-title" dir="auto" data-act="edit" data-id="${t.id}">${esc(t.title)}</div>
      ${meta ? `<div class="t-meta">${meta}</div>` : ''}
      ${stepsProgress(t)}
      ${subs ? `<div class="subs">${subs}</div>` : ''}</div>
    ${cardActions(t)}</article>`;
}

function boardCard(t) {
  const meta = taskMeta(t);
  return `<article class="task kcard p${t.priority} ${t.status === 'done' ? 'done' : ''}" draggable="true" data-drag="${t.id}" data-task="${t.id}">
    <div class="t-title" dir="auto" data-act="edit" data-id="${t.id}">${esc(t.title)}</div>
    ${meta ? `<div class="t-meta">${meta}</div>` : ''}
    ${stepsProgress(t)}
    ${cardActions(t)}
  </article>`;
}

// Chronological buckets shown as dividers inside board columns.
function dateBucket(t) {
  const info = TaskStore.dateInfo(t);
  if (!Number.isFinite(info.time)) return 'No date';
  const today = startOfDayMs(new Date()), day = startOfDayMs(new Date(info.time)), diff = Math.round((day - today) / 86400000);
  if (diff < 0) return t.status === 'done' ? 'Earlier' : 'Overdue';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff <= 7) return 'Next 7 days';
  return 'Later';
}
function groupedCards(items) {
  let last = null;
  return items.map((t) => {
    const g = dateBucket(t), head = g !== last ? `<div class="col-group ${g === 'Overdue' ? 'late' : ''}" role="separator">${g}</div>` : '';
    last = g; return head + boardCard(t);
  }).join('');
}

// ---------------------------------------------------------------- views
const view = () => $('#view');
const views = {};

async function go(name, keepScroll) {
  S.view = name;
  history.replaceState(null, '', '#/' + name);
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  setDrawer(false);
  try { await views[name](); } catch (e) { view().innerHTML = `<div class="card glass empty">Couldn't load this page.<br>${esc(e.message)}</div>`; }
  if (!keepScroll) window.scrollTo({ top: 0 });
}
const refresh = () => go(S.view, true);

// ---- dashboard
views.dashboard = async () => {
  const tasks = await TaskStore.list({status:'all'});
  const st = {open:tasks.filter(t=>t.status!=='done').length, overdue:tasks.filter(t=>t.status!=='done'&&t.due_at&&new Date(t.due_at)<new Date()).length, done_today:tasks.filter(t=>t.completed_at&&dayKey(new Date(t.completed_at))===dayKey(new Date())).length, focus_today_min:0, streak:0};
  const hour = new Date().getHours();
  const hi = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  view().innerHTML = `
    <h1>${hi}, ${esc(S.user.name.split(' ')[0])} 👋</h1>
    <div class="grid3">
      <div class="stat glass"><div class="num">${st.open}</div><div class="lbl">Open tasks</div></div>
      <div class="stat glass ${st.overdue ? 'warn' : ''}"><div class="num">${st.overdue}</div><div class="lbl">Overdue</div></div>
      <div class="stat glass good"><div class="num">${st.done_today}</div><div class="lbl">Done today</div></div>
      <div class="stat glass"><div class="num">${hm(st.focus_today_min)}</div><div class="lbl">Focused today</div></div>
      <div class="stat glass"><div class="num">${st.streak}🔥</div><div class="lbl">Day streak</div></div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <section class="card glass"><h2>🧭 Today's plan</h2>
        ${tasks.filter(t=>t.status!=='done').slice(0,5).map(t=>`<div class="block p${t.priority}"><span class="grow">${esc(t.title)}</span><button class="btn small" data-act="focus-task" data-id="${t.id}">Start</button></div>`).join('') || '<div class="empty">Nothing scheduled. Add a task to get started.</div>'}
      </section>
      <section class="card glass"><h2>⚠️ Needs attention</h2>
        ${st.overdue ? `<div class="risk overdue">${st.overdue} overdue task(s)</div>` : '<div class="empty">No overdue tasks. 🎉</div>'}
      </section>
    </div>
    <div class="grid2" style="margin-top:14px">
      <section class="card glass"><h2>📌 Coming up</h2>
        <div class="task-list">${tasks.filter(t=>t.status!=='done'&&t.due_at).slice(0,6).map(taskRow).join('') || '<div class="empty">No upcoming deadlines.</div>'}</div>
      </section>
      <section class="card glass"><h2>🤖 Daily briefing</h2>
        <div id="briefing" class="muted">Get a short summary of your day and what to do next.</div>
        <div class="row" style="margin-top:12px"><button class="btn primary" data-act="briefing">Generate briefing</button></div>
      </section>
    </div>`;
};

function riskHtml(r) {
  const label = { overdue: 'Overdue', high: 'At risk', medium: 'Tight', info: 'FYI' }[r.level];
  return `<div class="risk ${r.level}"><strong>${label}: ${esc(r.title)}</strong>
    <div class="muted">${esc(r.reason)}</div><div>💡 ${esc(r.suggestion)}</div></div>`;
}

// ---- tasks
function filterBar() {
  const f = S.filters;
  return `<div class="filters">
    <input type="text" id="f-q" placeholder="Search tasks, notes, #tags…" value="${esc(f.q)}" aria-label="Search">
    <select id="f-status" aria-label="Status"><option value="open" ${f.status === 'open' ? 'selected' : ''}>Open</option><option value="done" ${f.status === 'done' ? 'selected' : ''}>Completed</option><option value="all" ${f.status === 'all' ? 'selected' : ''}>All</option></select>
    <select id="f-project" aria-label="Project">${projectOptions(f.project, 'All projects')}</select>
    <select id="f-priority" aria-label="Priority"><option value="">Any priority</option>${[4, 3, 2, 1].map((p) => `<option value="${p}" ${f.priority === String(p) ? 'selected' : ''}>${PRIORITIES[p]}</option>`).join('')}</select>
    <select id="f-due" aria-label="Due"><option value="">Any due date</option>${[['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Next 7 days'], ['none', 'No due date']].map(([v, l]) => `<option value="${v}" ${f.due === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="f-sort" aria-label="Sort">${[['smart', 'Smart order'], ['due', 'Due date'], ['priority', 'Priority'], ['created', 'Newest']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  </div>`;
}

views.tasks = async () => {
  const f = S.filters;
  const qs = new URLSearchParams();
  if (S.trash) qs.set('trash', '1');
  else Object.entries(f).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const tasks = await TaskStore.list({ ...f, trash: S.trash });
  view().innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:10px"><h1 style="margin:0">${S.trash ? '🗑️ Trash' : '✅ Tasks'}</h1>
      <div class="row">
        ${S.trash ? '<button class="btn" data-act="trash-off">← Back to tasks</button>' : `
        <button class="btn primary" data-act="new-task">＋ New task</button>
        <button class="btn" data-act="select-mode">${S.selectMode ? 'Cancel select' : 'Select'}</button>
        <button class="btn" data-act="clear-done">Clear completed</button>
        <button class="btn ghost" data-act="trash-on">Trash</button>`}
      </div></div>
    ${S.trash ? '' : filterBar()}
    <div class="task-list">${tasks.length ? tasks.map(taskRow).join('') : `<div class="empty glass card">${S.trash ? 'Trash is empty.' : 'No tasks match. Try quick add above: <em>“read chapter 4 tomorrow 6pm #study”</em>'}</div>`}</div>
    <div class="bulkbar glass ${S.selectMode && S.selected.size ? 'show' : ''}" id="bulkbar">
      <strong>${S.selected.size} selected</strong>
      <button class="btn small mint" data-act="bulk" data-v="done">Complete</button>
      <select id="bulk-prio" aria-label="Set priority"><option value="">Priority…</option>${[4, 3, 2, 1].map((p) => `<option value="${p}">${PRIORITIES[p]}</option>`).join('')}</select>
      <select id="bulk-proj" aria-label="Move to project">${projectOptions('', 'Move to…')}</select>
      <button class="btn small danger" data-act="bulk" data-v="delete">Delete</button>
    </div>`;
  const reload = debounce(() => { views.tasks(); }, 250);
  const bind = (id, key, ev = 'change') => { const el = $(id); if (el) el.addEventListener(ev, () => { S.filters[key] = el.value; (ev === 'input' ? reload : views.tasks)(); }); };
  bind('#f-q', 'q', 'input'); bind('#f-status', 'status'); bind('#f-project', 'project'); bind('#f-priority', 'priority'); bind('#f-due', 'due'); bind('#f-sort', 'sort');
  const q = $('#f-q'); if (q && document.activeElement === document.body && S.filters.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  const bp = $('#bulk-prio'), bj = $('#bulk-proj');
  if (bp) bp.onchange = () => bp.value && bulk('priority', bp.value);
  if (bj) bj.onchange = () => bj.value !== '' && bulk('project', bj.value);
};

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function bulk(action, value) {
  if (!S.selected.size) return;
  try {
    await TaskStore.bulk([...S.selected], action, value);
    toast(`Updated ${S.selected.size} task(s)`);
    S.selected.clear(); S.selectMode = false; refresh();
  } catch (e) { fail(e); }
}

// ---- board
views.board = async () => {
  const tasks = await TaskStore.list({ status: 'all', sort: 'chrono', project: S.boardProject });
  const cols = [['todo', '📝 To do'], ['doing', '🚀 In progress'], ['done', '✅ Done']];
  const DONE_LIMIT = 25;
  view().innerHTML = `<div class="page-head"><div><h1>🗂️ Board</h1><p class="muted page-sub">Each column is ordered by date, earliest first.</p></div>
    <select id="b-proj" style="width:auto" aria-label="Filter by project">${projectOptions(S.boardProject, 'All projects')}</select></div>
    <div class="board">${cols.map(([k, label]) => {
      let items = tasks.filter((t) => t.status === k);
      const total = items.length;
      // Keep the most recently completed tasks, then show them in date order like the other columns.
      if (k === 'done' && total > DONE_LIMIT) items = items.slice().sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || ''))).slice(0, DONE_LIMIT).sort(TaskStore.compareChronological);
      return `<section class="col" data-col="${k}" aria-label="${label.replace(/^\S+\s/, '')}"><header class="col-head"><h2>${label}</h2><span class="count" title="${total} task${total === 1 ? '' : 's'}">${total > items.length ? `${items.length} of ${total}` : total}</span></header>
        <div class="col-body">${items.length ? groupedCards(items) : '<div class="empty col-empty">Drop tasks here</div>'}</div>
      </section>`; }).join('')}</div>`;
  $('#b-proj').onchange = (e) => { S.boardProject = e.target.value; views.board(); };
  $$('[data-drag]').forEach((el) => {
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', el.dataset.drag); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  $$('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', async (e) => {
      e.preventDefault(); col.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      try { await TaskStore.update(id, { status: col.dataset.col }); views.board(); } catch (err) { fail(err); }
    });
  });
};

// ---- calendar
const startOfWeek = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

views.calendar = async () => {
  const c = S.cal;
  const anchor = new Date(c.y, c.m, 1);
  let start, count;
  if (c.mode === 'month') { start = startOfWeek(anchor); count = 42; }
  else { start = startOfWeek(new Date(c.sel + 'T12:00:00')); count = 7; }
  const end = new Date(start); end.setDate(end.getDate() + count);
  const [localTasks, localEvents] = await Promise.all([TaskStore.list({status:'all'}), TaskStore.records('events')]);
  const events = localEvents.filter(e => new Date(e.end_at) >= start && new Date(e.start_at) <= end);
  const byDay = {};
  const add = (k, item) => { (byDay[k] = byDay[k] || []).push(item); };
  const flat = [];
  localTasks.forEach((t) => { flat.push(t); (t.subtasks || []).forEach((s) => flat.push(s)); });
  flat.filter((t) => t.due_at).forEach((t) => add(dayKey(new Date(t.due_at)), { kind: 't', at: new Date(t.due_at), t }));
  events.forEach((e) => {
    const s = new Date(e.start_at), en = new Date(e.end_at);
    for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= en; d.setDate(d.getDate() + 1)) add(dayKey(d), { kind: 'e', at: s, e });
  });
  const today = dayKey(new Date());
  const title = c.mode === 'month' ? anchor.toLocaleDateString([], { month: 'long', year: 'numeric' }) : `Week of ${fmtDay(start)}`;
  let cells = '';
  for (let i = 0; i < count; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const k = dayKey(d), items = (byDay[k] || []).sort((a, b) => a.at - b.at);
    const other = c.mode === 'month' && d.getMonth() !== c.m;
    const shown = c.mode === 'week' ? items : items.slice(0, 3);
    cells += `<button class="cal-day ${other ? 'other' : ''} ${k === today ? 'today' : ''} ${k === c.sel ? 'sel' : ''}" data-act="cal-sel" data-k="${k}" style="${c.mode === 'week' ? 'min-height:220px' : ''}">
      <div class="dn">${d.getDate()}</div>
      ${shown.map((it) => it.kind === 'e'
        ? `<div class="cal-item e">${fmtTime(it.e ? new Date(it.e.start_at) : it.at)} ${esc(it.e.title)}</div>`
        : `<div class="cal-item t ${it.t.status !== 'done' && it.at < new Date() ? 'late' : ''}">${it.t.status === 'done' ? '✓ ' : ''}${esc(it.t.title)}</div>`).join('')}
      ${items.length > shown.length ? `<div class="cal-item">+${items.length - shown.length} more</div>` : ''}</button>`;
  }
  const sel = byDay[c.sel] ? byDay[c.sel].sort((a, b) => a.at - b.at) : [];
  const selDate = new Date(c.sel + 'T12:00:00');
  view().innerHTML = `
    <div class="cal-head"><h1 style="margin:0;flex:1">📅 ${esc(title)}</h1>
      <div class="seg"><button class="${c.mode === 'month' ? 'on' : ''}" data-act="cal-mode" data-v="month">Month</button><button class="${c.mode === 'week' ? 'on' : ''}" data-act="cal-mode" data-v="week">Week</button></div>
      <button class="btn" data-act="cal-prev" aria-label="Previous">‹</button><button class="btn" data-act="cal-today">Today</button><button class="btn" data-act="cal-next" aria-label="Next">›</button>
      <button class="btn primary" data-act="new-event">＋ Event</button></div>
    <div class="cal-grid" style="margin-bottom:6px">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <section class="card glass" style="margin-top:14px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Agenda · ${esc(fmtDay(selDate))}</h2>
      <button class="btn small" data-act="new-task-day">＋ Task due this day</button></div>
      ${sel.length ? sel.map((it) => it.kind === 'e'
        ? `<div class="agenda-item"><span class="agenda-time">${fmtTime(new Date(it.e.start_at))}–${fmtTime(new Date(it.e.end_at))}</span><span class="grow">🗓️ ${esc(it.e.title)}</span><button class="btn small" data-act="edit-event" data-id="${it.e.id}">Edit</button></div>`
        : `<div class="agenda-item"><span class="agenda-time">${fmtTime(it.at)}</span><span class="grow">${it.t.status === 'done' ? '✅' : '☐'} ${esc(it.t.title)}</span><button class="btn small" data-act="edit" data-id="${it.t.id}">Open</button></div>`).join('')
        : '<div class="empty">Nothing on this day.</div>'}
    </section>`;
  S.calEvents = events;
};

function calShift(dir) {
  const c = S.cal;
  if (c.mode === 'month') { const d = new Date(c.y, c.m + dir, 1); c.y = d.getFullYear(); c.m = d.getMonth(); c.sel = dayKey(d); }
  else { const d = new Date(c.sel + 'T12:00:00'); d.setDate(d.getDate() + 7 * dir); c.sel = dayKey(d); c.y = d.getFullYear(); c.m = d.getMonth(); }
  views.calendar();
}

// ---- focus
views.focus = async () => {
  const tasks = await TaskStore.list({status:'open', sort:'priority'});
  const flat = [];
  tasks.forEach((t) => { if (!(t.subtasks || []).some((s) => s.status !== 'done')) flat.push(t); (t.subtasks || []).filter((s) => s.status !== 'done').forEach((s) => flat.push({ ...s, title: `${t.title} › ${s.title}` })); });
  const sn = TFTimer.snapshot();
  const logs = (await TaskStore.records('timeLogs')).filter(l=>Date.now()-new Date(l.started_at).getTime()<=7*86400000);
  const todayK = dayKey(new Date());
  const todaySec = logs.filter((l) => dayKey(new Date(l.started_at)) === todayK).reduce((a, l) => a + l.duration_sec, 0);
  const presets = [5, 10, 15, 25, 45, 60];
  view().innerHTML = `
    <h1>⏱️ Focus</h1>
    <div class="grid2">
      <section class="card glass timer-card">
        <div class="seg" id="mode-seg" role="tablist">${[['pomodoro', 'Pomodoro'], ['stopwatch', 'Stopwatch'], ['countdown', 'Countdown']].map(([m, l]) => `<button class="${sn.mode === m ? 'on' : ''}" data-act="timer-mode" data-v="${m}">${l}</button>`).join('')}</div>
        <div class="ring" id="ring"><svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="54" fill="none" stroke-width="8"/><circle class="fg" id="ring-fg" cx="60" cy="60" r="54" fill="none" stroke-width="8" stroke-dasharray="339.3" stroke-dashoffset="339.3"/></svg>
          <div class="time"><span id="t-clock">--:--</span><small id="t-phase"></small></div></div>
        <div id="t-cycles" class="muted"></div>
        <label style="max-width:360px;margin:10px auto">Working on<select id="t-task"><option value="">— no task —</option>${flat.map((t) => `<option value="${t.id}" ${sn.taskId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select></label>
        <div id="cd-box" class="row" style="justify-content:center;margin:8px 0" ${sn.mode === 'countdown' ? '' : 'hidden'}>
          ${presets.map((m) => `<button class="btn small" data-act="cd-preset" data-v="${m}">${m}m</button>`).join('')}
          <input type="number" id="cd-custom" min="1" max="600" placeholder="min" style="width:80px"></div>
        <div class="row" style="justify-content:center;margin-top:10px">
          <button class="btn primary" id="t-toggle" data-act="timer-toggle">Start</button>
          <button class="btn mint" data-act="timer-finish">Finish & log</button>
          <button class="btn" data-act="timer-skip" id="t-skip">Skip phase</button>
          <button class="btn danger" data-act="timer-reset">Reset</button></div>
        <p class="muted" style="margin-top:12px">Sessions survive reloads. Time is attached to the selected task.</p>
        <button class="btn small" data-act="notify-perm" id="notify-btn">🔔 Enable desktop alerts</button>
      </section>
      <section class="card glass"><h2>Time logged · last 7 days</h2>
        <p><strong>${hm(Math.round(todaySec / 60))}</strong> <span class="muted">focused today</span></p>
        ${logs.length ? logs.slice(0, 12).map((l) => `<div class="agenda-item"><span class="agenda-time">${esc(fmtDay(new Date(l.started_at)))}</span><span class="grow">${esc(l.title || 'No task')} <small class="muted">${esc(l.kind)}</small></span><strong>${hm(Math.round(l.duration_sec / 60))}</strong></div>`).join('') : '<div class="empty">No sessions yet. Start one!</div>'}
      </section>
    </div>`;
  paintTimer(TFTimer.snapshot());
  $('#t-task').onchange = (e) => TFTimer.setTask(e.target.value || null);
  const nb = $('#notify-btn');
  if (nb && ('Notification' in window) && Notification.permission === 'granted') nb.hidden = true;
};

function paintTimer(sn) {
  if (S.view !== 'focus' || !sn || !$('#ring')) return;
  const clock = sn.mode === 'stopwatch' ? mmss(sn.elapsedMs) : mmss(sn.remainingMs || sn.targetMs);
  $('#t-clock').textContent = sn.active || sn.mode === 'stopwatch' ? clock : mmss(sn.targetMs);
  const label = sn.mode === 'pomodoro' ? ({ work: 'Focus', short: 'Short break', long: 'Long break' }[sn.phase]) : (sn.mode === 'countdown' ? 'Countdown' : 'Stopwatch');
  $('#t-phase').textContent = label + (sn.running ? '' : (sn.active ? ' · paused' : ''));
  $('#ring').classList.toggle('break', sn.phase !== 'work');
  $('#ring-fg').style.strokeDashoffset = String(339.3 * (1 - (sn.targetMs ? sn.progress : (sn.running ? (sn.elapsedMs / 60000) % 1 : 0))));
  $('#t-toggle').textContent = sn.running ? 'Pause' : (sn.active ? 'Resume' : 'Start');
  $('#t-skip').hidden = sn.mode !== 'pomodoro';
  $('#t-cycles').textContent = sn.mode === 'pomodoro' ? `Session ${(sn.cycle % sn.cycles) + (sn.phase === 'work' ? 1 : 0)} of ${sn.cycles}` : '';
  $('#cd-box').hidden = sn.mode !== 'countdown';
}

function onTimerTick(sn) {
  const pill = $('#timer-pill');
  if (sn && sn.active) {
    const text = sn.mode === 'stopwatch' ? mmss(sn.elapsedMs) : mmss(sn.remainingMs);
    pill.hidden = false;
    pill.textContent = `${sn.running ? '⏱' : '⏸'} ${text}`;
    document.title = `${text} · TaskFlow`;
  } else { pill.hidden = true; document.title = 'TaskFlow'; }
  paintTimer(sn);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880, 660].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.22); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.22 + 0.2);
      o.start(ctx.currentTime + i * 0.22); o.stop(ctx.currentTime + i * 0.22 + 0.2);
    });
  } catch (e) { /* audio blocked */ }
}
function notify(title, body) {
  beep();
  if ('Notification' in window && Notification.permission === 'granted') { try { new Notification(title, { body }); } catch (e) { /* ignore */ } }
}
function onPhaseEnd(info) {
  if (info.mode === 'pomodoro') {
    if (info.finished === 'work') { notify('Focus session complete 🎉', `${info.minutes} min logged. ${info.next === 'long' ? 'Take a long break.' : 'Short break time.'}`); toast(`Focus session logged (${info.minutes} min). Break started.`); }
    else { notify('Break over', 'Ready for the next focus session?'); toast('Break over — ready when you are.'); }
  } else { notify("Time's up ⏰", `${info.minutes} min ${info.mode} finished and logged.`); toast("Time's up! Session logged."); }
  if (S.view === 'focus') views.focus();
}

// ---- planner
views.planner = async () => {
  const days = Number(sessionStorage.getItem('tf_plan_days') || 7);
  const tasks = await TaskStore.list({status:'open',sort:'due'});
  const events = await TaskStore.records('events');
  const p = {blocks:[],risks:[],conflicts:[],days:[]};
  const cursor = new Date(); cursor.setHours(S.user.work_start/60, S.user.work_start%60, 0, 0);
  tasks.filter(t=>t.status!=='done').forEach(t=>{
    const minutes=t.estimate_min||30, end=new Date(cursor.getTime()+minutes*60000);
    p.blocks.push({task_id:t.id,title:t.title,priority:t.priority,start:cursor.toISOString(),end:end.toISOString(),minutes});
    if(t.due_at&&end>new Date(t.due_at))p.risks.push({level:'high',title:t.title,reason:'Estimated completion is after the due date.',suggestion:'Reschedule or reduce the estimate.'});
    cursor.setTime(end.getTime());
  });
  for(let i=0;i<days;i++){const d=new Date();d.setDate(d.getDate()+i);const date=dayKey(d);const scheduled=p.blocks.filter(b=>dayKey(new Date(b.start))===date).reduce((n,b)=>n+b.minutes,0);p.days.push({date,scheduled_min:scheduled,capacity_min:Math.max(0,(S.user.work_end-S.user.work_start)-scheduled)});}
  p.conflicts=events.filter(e=>p.blocks.some(b=>new Date(b.start)<new Date(e.end_at)&&new Date(b.end)>new Date(e.start_at))).map(e=>({a:'Scheduled task',b:e.title}));
  const groups = {};
  p.blocks.forEach((b) => { const k = dayKey(new Date(b.start)); (groups[k] = groups[k] || []).push(b); });
  view().innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:10px"><h1 style="margin:0">🧭 Planner</h1>
      <div class="row"><label style="display:flex;gap:6px;align-items:center">Horizon<select id="p-days" style="width:auto">${[3, 7, 14].map((n) => `<option ${n === days ? 'selected' : ''} value="${n}">${n} days</option>`).join('')}</select></label>
      <button class="btn" data-act="advise">Priority advisor</button></div></div>
    <p class="muted">Deterministic scheduler: earliest deadline first, inside your working hours, around calendar events. Estimates come from each task (default 30 min).</p>
    <div class="grid2">
      <section class="card glass"><h2>⚠️ Deadline risks</h2>${p.risks.length ? p.risks.map(riskHtml).join('') : '<div class="empty">Everything fits before its deadline. ✅</div>'}
        ${p.conflicts.length ? `<h3 style="margin-top:12px">Calendar conflicts</h3>${p.conflicts.map((c) => `<div class="risk medium">“${esc(c.a)}” overlaps “${esc(c.b)}”</div>`).join('')}` : ''}
      </section>
      <section class="card glass"><h2>📊 Capacity</h2>
        ${p.days.map((d) => { const pct = d.capacity_min ? Math.min(100, Math.round(100 * d.scheduled_min / d.capacity_min)) : 0; return `<div style="margin:6px 0"><div class="row" style="justify-content:space-between"><span>${esc(fmtDay(new Date(d.date + 'T12:00:00')))}</span><small class="muted">${hm(d.scheduled_min)} of ${hm(d.capacity_min)}</small></div><div style="height:8px;border-radius:99px;background:var(--line)"><div style="height:8px;border-radius:99px;width:${pct}%;background:linear-gradient(90deg,var(--primary),var(--mint))"></div></div></div>`; }).join('')}
      </section></div>
    <section class="card glass" style="margin-top:14px"><h2>🗓️ Suggested schedule</h2>
      ${Object.keys(groups).sort().map((k) => `<h3 style="margin-top:10px">${esc(fmtDay(new Date(k + 'T12:00:00')))}</h3>${groups[k].map((b) => `
        <div class="block p${b.priority}"><span class="agenda-time">${fmtTime(new Date(b.start))}–${fmtTime(new Date(b.end))}</span><span class="grow">${esc(b.title)}</span><small class="muted">${b.minutes}m</small>
          <button class="btn small" data-act="focus-task" data-id="${b.task_id}">Start</button></div>`).join('')}`).join('') || '<div class="empty">No open tasks to schedule. Add some with due dates and estimates.</div>'}
    </section>`;
  $('#p-days').onchange = (e) => { sessionStorage.setItem('tf_plan_days', e.target.value); views.planner(); };
};

// ---- AI agents
function proposalHtml(p, history) {
  const pl = p.payload;
  let body = '';
  if (p.kind === 'decompose') body = `<ul>${pl.subtasks.map((s) => `<li>${esc(s.title)} ${s.estimate_min ? `<small class="muted">· ${s.estimate_min}m</small>` : ''}</li>`).join('')}</ul>`;
  else if (p.kind === 'plan') body = `<div><strong>${esc(pl.parent.title)}</strong> ${pl.parent.due_at ? `<span class="chip">📅 ${esc(fmtDateTime(pl.parent.due_at.replace(' ', 'T') + 'Z'))}</span>` : ''}</div><ul>${pl.subtasks.map((s) => `<li>${esc(s.title)} ${s.estimate_min ? `<small class="muted">· ${s.estimate_min}m</small>` : ''}</li>`).join('')}</ul>`;
  else if (p.kind === 'priority') body = `<p>Set priority to <strong>${PRIORITIES[pl.priority]}</strong> — ${esc(pl.reason || '')}</p>`;
  const actions = p.status === 'pending'
    ? `<div class="row"><button class="btn small mint" data-act="approve" data-id="${p.id}">Approve</button><button class="btn small" data-act="reject" data-id="${p.id}">Reject</button></div>`
    : `<span class="chip">${esc(p.status)}</span>`;
  return `<div class="proposal"><div class="row" style="justify-content:space-between"><strong>${esc(p.title)}</strong><span class="pill ${p.source === 'llm' ? 'llm' : ''}">${p.source === 'llm' ? 'AI model' : 'Built-in rules'}</span></div>${body}${history && p.status === 'pending' ? '' : actions}</div>`;
}

async function refreshBadge() {
  try {
    const proposals = (await TaskStore.records('proposals')).filter(p => p.status === 'pending');
    const b = $('#proposal-badge');
    if (!b) return proposals;
    b.hidden = !proposals.length; b.textContent = proposals.length;
    return proposals;
  } catch (e) { return []; }
}

views.agents = async () => {
  view().innerHTML = `
    <section class="copilot-shell">
      <header class="copilot-heading"><span class="copilot-mark" aria-hidden="true">✦</span><div><h1>AI Copilot</h1><p class="muted">Plan work, find tasks, and update your board. English and Arabic supported.</p></div></header>
      <div id="copilot-output" class="chat-transcript" role="log" aria-live="polite" aria-relevant="additions text">
        <div class="chat-welcome">What would you like to work on?</div>
      </div>
      <form id="copilot-form" class="copilot-composer"><textarea id="copilot-input" rows="2" maxlength="4000" autocomplete="off" dir="auto" placeholder="اكتب طلبك هنا أو اسأل الذكاء الاصطناعي… / Type a request or ask your AI Copilot…" aria-label="Message AI Copilot"></textarea><button class="btn primary" type="submit">Send</button></form>
    </section>`;
  const cf=$('#copilot-form'), input=$('#copilot-input');
  if(cf) cf.onsubmit=async e=>{e.preventDefault();await runCopilot(input.value.trim());};
  input.addEventListener('input',()=>{input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,240)}px`;});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();cf.requestSubmit();}});
};

function reviewHtml(r) {
  return `<section class="card glass" style="margin-top:14px"><div class="row" style="justify-content:space-between"><h2>${r.kind === 'daily' ? '☀️ Daily briefing' : '📆 Weekly review'}</h2><span class="pill ${r.source === 'llm' ? 'llm' : ''}">${r.source === 'llm' ? 'AI model' : 'Built-in rules'}</span></div>
    <p>${esc(r.summary)}</p><ul>${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    ${r.risks.length ? r.risks.map(riskHtml).join('') : ''}</section>`;
}

// ---- analytics
function bars(days, key, cls) {
  const max = Math.max(1, ...days.map((d) => d[key]));
  return `<div class="bars">${days.map((d) => `<div class="bar-col" title="${esc(d.date)}: ${d[key]}"><span class="bar-val">${d[key] || ''}</span><div class="bar ${cls}" style="height:${Math.round(100 * d[key] / max)}%"></div><span class="bar-lbl">${new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'narrow' })}</span></div>`).join('')}</div>`;
}
views.analytics = async () => {
  const [tasks, logs] = await Promise.all([TaskStore.list({status:'all'}), TaskStore.records('timeLogs')]);
  const days = Array.from({length:14},(_,i)=>{const d=new Date();d.setDate(d.getDate()-13+i);const k=dayKey(d);return {date:k,done:tasks.filter(t=>t.completed_at&&dayKey(new Date(t.completed_at))===k).length,focus_min:Math.round(logs.filter(l=>dayKey(new Date(l.started_at))===k).reduce((n,l)=>n+l.duration_sec,0)/60)};});
  const open=tasks.filter(t=>t.status!=='done'), done=tasks.filter(t=>t.status==='done'), due=done.filter(t=>t.due_at&&t.completed_at);
  const a={days,streak:0,done_week:done.filter(t=>t.completed_at&&Date.now()-new Date(t.completed_at)<7*86400000).length,focus_week_min:Math.round(logs.filter(l=>Date.now()-new Date(l.started_at)<7*86400000).reduce((n,l)=>n+l.duration_sec,0)/60),on_time_rate:due.length?Math.round(100*due.filter(t=>new Date(t.completed_at)<=new Date(t.due_at)).length/due.length):null,last_minute_rate:null,estimate_accuracy:null,by_project:Object.fromEntries(S.projects.map(p=>[p.name,open.filter(t=>t.project_id===p.id).length])),by_priority:Object.fromEntries([4,3,2,1].map(p=>[p,open.filter(t=>t.priority===p).length]))};
  const pct = (v) => (v === null ? '—' : v + '%');
  view().innerHTML = `
    <h1>📊 Analytics</h1>
    <div class="grid3">
      <div class="stat glass good"><div class="num">${a.streak}🔥</div><div class="lbl">Day streak</div></div>
      <div class="stat glass"><div class="num">${a.done_week}</div><div class="lbl">Done · last 7 days</div></div>
      <div class="stat glass"><div class="num">${hm(a.focus_week_min)}</div><div class="lbl">Focus · last 7 days</div></div>
      <div class="stat glass"><div class="num">${pct(a.on_time_rate)}</div><div class="lbl">Finished on time</div></div>
      <div class="stat glass"><div class="num">${pct(a.last_minute_rate)}</div><div class="lbl">Finished &lt;6h before due</div></div>
      <div class="stat glass"><div class="num">${a.estimate_accuracy === null ? '—' : a.estimate_accuracy + '×'}</div><div class="lbl">Actual ÷ estimated time</div></div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <section class="card glass"><h2>Tasks completed · 14 days</h2>${bars(a.days, 'done', '')}</section>
      <section class="card glass"><h2>Focus minutes · 14 days</h2>${bars(a.days, 'focus_min', 'focus')}</section>
      <section class="card glass"><h2>Open work by project</h2>${Object.entries(a.by_project).map(([k, v]) => `<div class="agenda-item"><span class="grow">${esc(k)}</span><strong>${v}</strong></div>`).join('') || '<div class="empty">Nothing open.</div>'}</section>
      <section class="card glass"><h2>Open work by priority</h2>${Object.entries(a.by_priority).map(([k, v]) => `<div class="agenda-item"><span class="grow">${PRIORITIES[k]}</span><strong>${v}</strong></div>`).join('') || '<div class="empty">Nothing open.</div>'}</section>
    </div>
    <p class="muted" style="margin-top:12px">Metrics are descriptive, not scores. “Actual ÷ estimated” above 1.3× suggests padding your estimates.</p>`;
};

// ---- settings
views.settings = async () => {
  const u = S.user;
  view().innerHTML = `
    <h1>⚙️ Settings</h1>
    <form id="settings-form" class="card glass" style="display:grid;gap:14px">
      <div class="grid2">
        <label>Name<input type="text" id="s-name" maxlength="60" value="${esc(u.name)}"></label>
        <label>Email<input type="text" value="${esc(u.email)}" disabled></label>
        <label>Work day starts<input type="time" id="s-ws" value="${minToTime(u.work_start)}"></label>
        <label>Work day ends<input type="time" id="s-we" value="${minToTime(u.work_end === 1440 ? 1439 : u.work_end)}"></label>
        <label>Quiet hours start<input type="time" id="s-qs" value="${minToTime(u.quiet_start)}"></label>
        <label>Quiet hours end<input type="time" id="s-qe" value="${minToTime(u.quiet_end)}"></label>
        <label>Remind me before due (minutes)<input type="number" id="s-lead" min="0" max="10080" value="${u.remind_lead}"></label>
        <label>Pomodoro focus (min)<input type="number" id="s-pw" min="1" max="180" value="${u.pomo_work}"></label>
        <label>Short break (min)<input type="number" id="s-ps" min="1" max="60" value="${u.pomo_short}"></label>
        <label>Long break (min)<input type="number" id="s-pl" min="1" max="120" value="${u.pomo_long}"></label>
        <label>Sessions before long break<input type="number" id="s-pc" min="1" max="12" value="${u.pomo_cycles}"></label>
      </div>
      <p class="muted">Time zone offset detected from this browser: UTC${u.tz_offset >= 0 ? '+' : '−'}${Math.floor(Math.abs(u.tz_offset) / 60)}:${pad(Math.abs(u.tz_offset) % 60)} (updates each time you open the app, so daylight-saving changes are followed). Quiet hours silence reminders; they appear again afterwards.</p>
      <div class="row"><button class="btn primary" type="submit">Save settings</button>
        <button class="btn" type="button" data-act="notify-perm">🔔 Enable desktop alerts</button></div>
    </form>
    <section class="card glass" style="margin-top:14px"><h2>📁 Projects</h2>
      <div class="row">${S.projects.map((p) => `<span class="chip" style="background:${esc(p.color)}44"><button class="btn small ghost" data-act="edit-project" data-id="${p.id}">${esc(p.name)}</button><button class="btn small ghost" data-act="del-project" data-id="${p.id}" aria-label="Delete project">✕</button></span>`).join('') || '<span class="muted">No projects yet.</span>'}</div>
      <form id="project-form" class="row" style="margin-top:10px"><input type="text" id="p-name" maxlength="40" placeholder="New project name" style="max-width:260px"><input type="color" id="p-color" value="#7b6cf0" aria-label="Project color"><button class="btn" type="submit">Add project</button></form></section>
    <section class="card glass" style="margin-top:14px"><h2>💾 Your data</h2>
      <p class="muted">Free hosting can wipe the database on redeploy. Export a backup now and then — you can import it back at any time.</p>
      <div class="row"><button class="btn" data-act="export">Export backup (JSON)</button>
        <label class="btn" style="cursor:pointer;display:inline-block">Import backup<input type="file" id="import-file" accept="application/json" hidden></label></div></section>`;
  $('#settings-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      S.user = await TaskStore.saveRecord('settings', {...S.user,
        name: $('#s-name').value, work_start: timeToMin($('#s-ws').value), work_end: timeToMin($('#s-we').value),
        quiet_start: timeToMin($('#s-qs').value), quiet_end: timeToMin($('#s-qe').value), remind_lead: Number($('#s-lead').value),
        pomo_work: Number($('#s-pw').value), pomo_short: Number($('#s-ps').value), pomo_long: Number($('#s-pl').value), pomo_cycles: Number($('#s-pc').value),
      });
      $('#user-name').textContent = S.user.name; TFTimer.updateSettings(S.user);
      toast('Settings saved');
    } catch (err) { fail(err); }
  };
  $('#project-form').onsubmit = async (e) => {
    e.preventDefault();
    try { const p=await TaskStore.saveRecord('projects',{name:$('#p-name').value.trim(),color:$('#p-color').value}); S.projects.push(p); views.settings(); toast('Project added'); } catch (err) { fail(err); }
  };
  $('#import-file').onchange = async (e) => {
    await importTasksFile(e.target.files[0]); e.target.value = '';
  };
};

// ---------------------------------------------------------------- dialogs
function openTaskDialog(task, defaults = {}) {
  const t = task || { title: '', notes: '', status: 'todo', priority: 2, due_at: null, estimate_min: null, tags: [], recurrence: 'none', project_id: null, subtasks: [], ...defaults };
  const dlg = $('#task-dialog');
  dlg.innerHTML = `<form method="dialog" id="task-form">
    <h2>${task ? 'Edit task' : 'New task'}</h2>
    <label>Title<input type="text" id="d-title" maxlength="200" required value="${esc(t.title)}"></label>
    <label>Notes<textarea id="d-notes" maxlength="2000">${esc(t.notes)}</textarea></label>
    <div class="grid2">
      <label>Due<input type="datetime-local" id="d-due" value="${toLocalInput(t.due_at)}"></label>
      <label>Estimate (minutes)<input type="number" id="d-est" min="1" max="1440" value="${t.estimate_min || ''}"></label>
      <label>Priority<select id="d-prio">${[1, 2, 3, 4].map((p) => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${PRIORITIES[p]}</option>`).join('')}</select></label>
      <label>Status<select id="d-status">${[['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']].map(([v, l]) => `<option value="${v}" ${t.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Project<select id="d-proj">${projectOptions(t.project_id)}</select></label>
      <label>Repeats<select id="d-rec">${[['none', 'Never'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([v, l]) => `<option value="${v}" ${t.recurrence === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label>Tags (comma separated)<input type="text" id="d-tags" value="${esc(t.tags.join(', '))}"></label>
    ${task && !task.parent_id ? `<div><h3>Steps</h3><div class="subs" id="d-subs">${(t.subtasks || []).map((s) => `<label class="${s.status === 'done' ? 'done' : ''}"><input type="checkbox" data-act="toggle" data-id="${s.id}" ${s.status === 'done' ? 'checked' : ''}><span>${esc(s.title)}</span></label>`).join('') || '<span class="muted">No steps yet.</span>'}</div>
      <div class="row" style="margin-top:8px"><input type="text" id="d-newsub" class="grow" maxlength="200" placeholder="Add a step…"><button class="btn small" type="button" id="d-addsub">Add</button></div></div>` : ''}
    <div class="row" style="justify-content:space-between">
      <div class="row">${task ? `<button class="btn small" type="button" id="d-ai">🤖 Break down with AI</button><button class="btn small" type="button" id="d-remind">🔔 Add reminder</button>` : ''}</div>
      <div class="row"><button class="btn" type="button" id="d-cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></div>
  </form>`;
  dlg.showModal();
  $('#d-cancel').onclick = () => dlg.close();
  $('#task-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      title: $('#d-title').value, notes: $('#d-notes').value, due_at: fromLocalInput($('#d-due').value),
      estimate_min: $('#d-est').value ? Number($('#d-est').value) : null, priority: Number($('#d-prio').value),
      status: $('#d-status').value, project_id: $('#d-proj').value || null,
      recurrence: $('#d-rec').value, tags: $('#d-tags').value,
    };
    try {
      if (task) await TaskStore.update(task.id, body); else await TaskStore.create(body);
      dlg.close(); toast('Saved'); refresh(); refreshBadge();
    } catch (err) { fail(err); }
  };
  if (task && !task.parent_id) {
    const add = async () => {
      const v = $('#d-newsub').value.trim(); if (!v) return;
      try { await TaskStore.create({ title: v, parent_id: task.id, project_id: task.project_id }); const fresh = await TaskStore.get(task.id); fresh.subtasks = (await TaskStore.list({status:'all'})).flatMap(x => x.subtasks || []).filter(x => x.parent_id === task.id); dlg.close(); openTaskDialog(fresh); refresh(); } catch (err) { fail(err); }
    };
    $('#d-addsub').onclick = add;
    $('#d-newsub').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  }
  const ai = $('#d-ai');
  if (ai) ai.onclick = async () => {
    ai.disabled = true;
    try { dlg.close(); await go('agents'); await runCopilot(`Break down this task into useful subtasks: ${task.title}`); } catch (err) { fail(err); ai.disabled = false; }
  };
  const rm = $('#d-remind');
  if (rm) rm.onclick = async () => {
    const v = prompt('Remind me at (YYYY-MM-DD HH:MM, your local time):', toLocalInput(new Date(Date.now() + 3600000).toISOString()).replace('T', ' '));
    if (!v) return;
    const d = new Date(v.replace(' ', 'T'));
    if (isNaN(d)) { toast('That date/time was not understood', 'err'); return; }
    try { await TaskStore.saveRecord('reminders',{task_id:task.id,remind_at:d.toISOString(),message:'Reminder',delivered_at:null}); toast('Reminder set'); } catch (err) { fail(err); }
  };
}

function openEventDialog(ev, defaultDay) {
  const dlg = $('#event-dialog');
  const base = defaultDay ? new Date(defaultDay + 'T09:00:00') : new Date();
  const s = ev ? new Date(ev.start_at) : base, e = ev ? new Date(ev.end_at) : new Date(base.getTime() + 3600000);
  dlg.innerHTML = `<form method="dialog" id="event-form"><h2>${ev ? 'Edit event' : 'New event'}</h2>
    <label>Title<input type="text" id="e-title" maxlength="120" required value="${esc(ev ? ev.title : '')}"></label>
    <div class="grid2"><label>Starts<input type="datetime-local" id="e-start" required value="${toLocalInput(s.toISOString())}"></label>
    <label>Ends<input type="datetime-local" id="e-end" required value="${toLocalInput(e.toISOString())}"></label></div>
    <label>Notes<textarea id="e-notes" maxlength="1000">${esc(ev ? ev.notes : '')}</textarea></label>
    <div class="row" style="justify-content:space-between"><div>${ev ? '<button class="btn danger" type="button" id="e-del">Delete</button>' : ''}</div>
    <div class="row"><button class="btn" type="button" id="e-cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></div></form>`;
  dlg.showModal();
  $('#e-cancel').onclick = () => dlg.close();
  $('#event-form').onsubmit = async (evt) => {
    evt.preventDefault();
    const body = { title: $('#e-title').value, start_at: fromLocalInput($('#e-start').value), end_at: fromLocalInput($('#e-end').value), notes: $('#e-notes').value };
    try { if (ev) await TaskStore.saveRecord('events', {...ev,...body}); else await TaskStore.saveRecord('events', body); dlg.close(); toast('Event saved'); refresh(); } catch (err) { fail(err); }
  };
  const del = $('#e-del');
  if (del) del.onclick = async () => { try { await TaskStore.deleteRecord('events', ev.id); dlg.close(); toast('Event deleted'); refresh(); } catch (err) { fail(err); } };
}

// ---------------------------------------------------------------- actions (event delegation)
const actions = {
  async toggle(el) {
    try { await TaskStore.update(el.dataset.id, { status: el.checked ? 'done' : 'todo' }); if (el.checked) toast('Nice work ✓'); await refresh(); refreshBadge(); } catch (e) { fail(e); el.checked = !el.checked; }
  },
  select(el) { const id = el.dataset.id; el.checked ? S.selected.add(id) : S.selected.delete(id); $('#bulkbar').classList.toggle('show', S.selected.size > 0); $('#bulkbar strong').textContent = `${S.selected.size} selected`; },
  async edit(el) { try { openTaskDialog(await TaskStore.get(el.dataset.id)); } catch (e) { fail(e); } },
  async del(el) {
    const id = el.dataset.id;
    try { await TaskStore.remove(id); toast('Task deleted', 'ok', { label: 'Undo', fn: async () => { await TaskStore.restore(id); refresh(); } }); refresh(); } catch (e) { fail(e); }
  },
  async restore(el) { try { await TaskStore.restore(el.dataset.id); toast('Restored'); refresh(); } catch (e) { fail(e); } },
  async purge(el) { if (!confirm('Delete this task forever?')) return; try { await TaskStore.purge(el.dataset.id); refresh(); } catch (e) { fail(e); } },
  'new-task'() { openTaskDialog(null); },
  'new-task-day'() { const d = new Date(S.cal.sel + 'T17:00:00'); openTaskDialog(null, { due_at: d.toISOString() }); },
  'select-mode'() { S.selectMode = !S.selectMode; S.selected.clear(); refresh(); },
  'trash-on'() { S.trash = true; refresh(); },
  'trash-off'() { S.trash = false; refresh(); },
  async 'clear-done'() { if (!confirm('Move all completed tasks to the trash?')) return; try { const cleared = await TaskStore.clearDone(); toast(`${cleared} task(s) moved to trash`); refresh(); } catch (e) { fail(e); } },
  bulk(el) { if (el.dataset.v === 'delete' && !confirm(`Delete ${S.selected.size} task(s)?`)) return; bulk(el.dataset.v); },
  'focus-task'(el) { TFTimer.setTask(el.dataset.id || null); go('focus'); },
  async move(el) {
    try { await TaskStore.update(el.dataset.id, { status: el.dataset.v }); if (el.dataset.v === 'done') toast('Nice work ✓'); await refresh(); refreshBadge(); } catch (e) { fail(e); }
  },
  async briefing() { await go('agents'); await runCopilot('Summarize today’s tasks and recommend what I should focus on.'); },
  async review(el) { await runCopilot(el.dataset.v==='weekly'?'Review my tasks this week and suggest a realistic plan.':'Summarize today’s tasks and recommend priorities.'); },
  async advise() { await runCopilot('Identify overdue and high-priority tasks and recommend priority changes.'); },
  async 'copilot-prompt'(el) { await runCopilot(el.dataset.prompt); },
  async 'plan-goal'() { const g=$('#goal').value.trim(); if(g.length<3){toast('Describe your goal first','err');return;} await runCopilot(`Create and schedule a task plan for this goal: ${g}`); },
  async approve(el) {
    try {
      const p=(await TaskStore.records('proposals')).find(x=>String(x.id)===el.dataset.id); if(!p)throw new Error('Proposal is not available locally');
      const d=typeof p.payload==='string'?JSON.parse(p.payload):p.payload;
      if(p.kind==='priority') await TaskStore.update(d.task_id,{priority:d.priority});
      else if(p.kind==='decompose') { for(const s of d.subtasks||[]) await TaskStore.create({title:s.title,priority:s.priority||2,estimate_min:s.estimate_min,parent_id:d.task_id}); }
      else if(p.kind==='plan') { const parent=await TaskStore.create(d.parent); for(const s of d.subtasks||[]) await TaskStore.create({title:s.title,priority:s.priority||2,estimate_min:s.estimate_min,parent_id:parent.id}); }
      p.status='approved';p.decided_at=new Date().toISOString();await TaskStore.saveRecord('proposals',p);toast('Approved and applied');await views.agents();
    } catch(e) { fail(e); }
  },
  async reject(el) { try { const p=(await TaskStore.records('proposals')).find(x=>String(x.id)===el.dataset.id); if(!p)throw new Error('Proposal is not available locally');p.status='rejected';p.decided_at=new Date().toISOString();await TaskStore.saveRecord('proposals',p);await views.agents(); } catch(e) { fail(e); } },
  'cal-sel'(el) { S.cal.sel = el.dataset.k; const d = new Date(el.dataset.k + 'T12:00:00'); if (S.cal.mode === 'month') { S.cal.y = d.getFullYear(); S.cal.m = d.getMonth(); } views.calendar(); },
  'cal-mode'(el) { S.cal.mode = el.dataset.v; views.calendar(); },
  'cal-prev'() { calShift(-1); }, 'cal-next'() { calShift(1); },
  'cal-today'() { const n = new Date(); S.cal = { ...S.cal, y: n.getFullYear(), m: n.getMonth(), sel: dayKey(n) }; views.calendar(); },
  'new-event'() { openEventDialog(null, S.cal.sel); },
  'edit-event'(el) { const ev = (S.calEvents || []).find((x) => String(x.id) === el.dataset.id); if (ev) openEventDialog(ev); },
  'timer-mode'(el) { if (!TFTimer.setMode(el.dataset.v)) { toast('Finish or reset the running session first', 'err'); return; } views.focus(); },
  'timer-toggle'() { const sn = TFTimer.snapshot(); sn.running ? TFTimer.pause() : TFTimer.start(); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); },
  async 'timer-finish'() { const ms = await TFTimer.finish(); toast(ms >= 10000 ? `Logged ${hm(Math.max(1, Math.round(ms / 60000)))}` : 'Too short to log (under 10 s)'); if (S.view === 'focus') views.focus(); },
  'timer-skip'() { TFTimer.skipPhase(); },
  'timer-reset'() { if (confirm('Discard this session without logging?')) TFTimer.reset(); },
  'cd-preset'(el) { TFTimer.setCountdown(Number(el.dataset.v)); },
  async 'notify-perm'() { if (!('Notification' in window)) { toast('This browser does not support notifications', 'err'); return; } const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Desktop alerts enabled' : 'Alerts not enabled', r === 'granted' ? 'ok' : 'err'); },
  async 'del-project'(el) { if (!confirm('Delete this project? Its tasks are kept.')) return; try { await TaskStore.deleteRecord('projects',el.dataset.id); S.projects=S.projects.filter(p=>p.id!==el.dataset.id); views.settings(); } catch (e) { fail(e); } },
  async 'edit-project'(el) { const p=S.projects.find(x=>x.id===el.dataset.id); if(!p)return; const name=prompt('Project name:',p.name); if(name===null)return; try { const changed=await TaskStore.saveRecord('projects',{...p,name:name.trim()}); S.projects=S.projects.map(x=>x.id===p.id?changed:x); views.settings(); } catch(e){fail(e);} },
  export() { return exportTasks(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches && el.matches('input[data-act]')) { const fn = actions[el.dataset.act]; if (fn) fn(el); }
  if (el.id === 'cd-custom' && el.value) { TFTimer.setCountdown(Number(el.value)); }
});

// ---------------------------------------------------------------- quick add
$('#quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#quick-input'); const text = input.value.trim();
  if (!text) return;
  try {
    await TaskStore.create({ title: text });
    input.value = '';
    toast(`Added “${text}”`);
    if (['tasks', 'dashboard', 'board', 'calendar'].includes(S.view)) refresh();
  } catch (err) { fail(err); }
});

// ---------------------------------------------------------------- reminders
const shown = new Set();
async function pollReminders() {
  try {
    const reminders=await TaskStore.records('reminders'); const tasks=await TaskStore.list({status:'all'});
    const due=reminders.filter(r=>!r.delivered_at&&new Date(r.remind_at)<=new Date()).map(r=>({...r,title:tasks.find(t=>t.id===r.task_id)?.title||'Task'}));
    for (const rem of due) {
      if (shown.has(rem.id)) continue;
      shown.add(rem.id);
      const when = rem.due_at ? ` · due ${fmtDateTime(rem.due_at)}` : '';
      const t = toast(`🔔 ${rem.title}${when}`, 'remind');
      const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = label; b.onclick = async () => { await fn(); t.remove(); }; t.appendChild(b); };
      mk('Snooze 10m', async () => { shown.delete(rem.id); await TaskStore.saveRecord('reminders',{...rem,remind_at:new Date(Date.now()+600000).toISOString(),delivered_at:null}); });
      mk('Done', async () => { const task = await TaskStore.get(rem.task_id); if (task) await TaskStore.update(task.id, { status: 'done' }); refresh(); });
      mk('Dismiss', async () => {});
      setTimeout(() => t.remove(), 60000);
      notify('Reminder', rem.title + when);
      await TaskStore.saveRecord('reminders',{...rem,delivered_at:new Date().toISOString()});
    }
  } catch (e) { /* offline: try again next tick */ }
}

// ---------------------------------------------------------------- boot
async function loadMe() {
  const local = await TaskStore.initializeDefaults();
  S.user = local.settings;
  S.user.name = S.user.name || 'Local User';
  S.projects = await TaskStore.records('projects');
  S.ai = {enabled:true, provider:'OpenRouter'};
  $('#user-name').textContent = S.user.name;
}

function setupTheme() {
  const saved = localStorage.getItem('tf_theme');
  const dark = saved === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-btn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tf_theme', next); } catch (e) { /* ignore */ }
  };
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#quick-input').focus(); }
  else if (e.key === 'n') { e.preventDefault(); openTaskDialog(null); }
  else if (e.key === 'f') { go('focus'); }
});

// ---------------------------------------------------------------- sidebar
const SIDEBAR_KEY = 'tf_sidebar_collapsed';
const mobileQuery = window.matchMedia('(max-width: 860px)');
function syncSidebarUi() {
  const toggle = $('#sidebar-toggle'), collapsed = document.documentElement.classList.contains('sidebar-collapsed');
  const label = mobileQuery.matches ? 'Close menu' : (collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  toggle.setAttribute('aria-label', label); toggle.title = label;
  toggle.setAttribute('aria-expanded', String(mobileQuery.matches ? $('#sidebar').classList.contains('open') : !collapsed));
}
function setDrawer(open) {
  const isOpen = !!open && mobileQuery.matches;
  $('#sidebar').classList.toggle('open', isOpen);
  $('#sidebar-scrim').hidden = !isOpen;
  document.body.classList.toggle('drawer-open', isOpen);
  $('#menu-btn').setAttribute('aria-expanded', String(isOpen));
  syncSidebarUi();
}
let sidebarAnimTimer;
function setCollapsed(collapsed) {
  const root = document.documentElement;
  root.classList.add('sb-animating');
  clearTimeout(sidebarAnimTimer);
  sidebarAnimTimer = setTimeout(() => root.classList.remove('sb-animating'), 320);
  root.classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  syncSidebarUi();
}
function setupSidebar() {
  $('#sidebar-toggle').onclick = () => {
    if (mobileQuery.matches) { setDrawer(false); $('#menu-btn').focus(); }
    else setCollapsed(!document.documentElement.classList.contains('sidebar-collapsed'));
  };
  $('#menu-btn').onclick = () => setDrawer(!$('#sidebar').classList.contains('open'));
  $('#sidebar-scrim').onclick = () => setDrawer(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#sidebar').classList.contains('open')) setDrawer(false); });
  const onViewportChange = () => setDrawer(false);
  if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onViewportChange); else mobileQuery.addListener(onViewportChange);
  syncSidebarUi();
}

// ---------------------------------------------------------------- data tools
async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}
async function exportTasks() {
  try {
    const count = await withBusy($('#export-json-btn'), () => TaskStore.exportToFile(`taskflow-tasks-${dayKey(new Date())}.json`));
    toast(count ? `Exported ${count} task${count === 1 ? '' : 's'}` : 'Exported an empty task list');
  } catch (e) { fail(e); }
}
async function importTasksFile(file) {
  if (!file) return;
  try {
    const res = await withBusy($('#import-json-btn'), () => TaskStore.importFromFile(file));
    S.projects = await TaskStore.records('projects');
    toast(`Imported ${res.tasks} task${res.tasks === 1 ? '' : 's'}${res.projects ? ` and ${res.projects} project${res.projects === 1 ? '' : 's'}` : ''}`);
    await refresh(); refreshBadge();
  } catch (e) { fail(e); }
}
const APP_STORAGE_KEYS = ['taskflow-copilot-memory-v1', 'tf_timer_v1'];
async function killAllData() {
  if (!confirm('Killer: permanently delete ALL TaskFlow data in this browser?\n\nThis removes every task, subtask, project, reminder, focus log and the Copilot chat history. It cannot be undone. Export a JSON backup first if you might need it.')) return;
  try {
    await withBusy($('#killer-btn'), async () => {
      try { TFTimer.reset(); } catch (e) { /* no active session */ }
      if (window.TaskFlowAgent?.clearMemory) TaskFlowAgent.clearMemory();
      await TaskStore.clearAll();
      try {
        APP_STORAGE_KEYS.forEach((k) => localStorage.removeItem(k));
        Object.keys(sessionStorage).filter((k) => k.startsWith('tf_') || k.startsWith('taskflow')).forEach((k) => sessionStorage.removeItem(k));
      } catch (e) { /* storage unavailable */ }
    });
    sessionStorage.setItem('tf_flash', 'All local data was cleared');
    history.replaceState(null, '', location.pathname + '#/tasks'); location.reload();
  } catch (e) { fail(e); }
}
function setupDataTools() {
  $('#export-json-btn').onclick = exportTasks;
  $('#import-json-btn').onclick = () => $('#import-json-file').click();
  $('#import-json-file').onchange = async (e) => { await importTasksFile(e.target.files[0]); e.target.value = ''; };
  $('#killer-btn').onclick = killAllData;
}

let crossTabRefreshQueued = false;
TaskStore.onChange((e) => {
  if (e?.data?.type === 'cleared') { location.reload(); return; }
  if (!['tasks', 'board'].includes(S.view) || crossTabRefreshQueued) return;
  crossTabRefreshQueued = true;
  requestAnimationFrame(() => {
    crossTabRefreshQueued = false;
    if (['tasks', 'board'].includes(S.view)) refresh();
  });
});

async function boot() {
  setupTheme();
  setupSidebar();
  setupDataTools();
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); });
  $('#timer-pill').onclick = () => go('focus');
  await loadMe();
  const offset = -new Date().getTimezoneOffset();
  if (offset !== S.user.tz_offset) { S.user.tz_offset = offset; await TaskStore.saveRecord('settings', S.user); }
  TFTimer.init(S.user, { onTick: onTimerTick, onPhaseEnd, log: async b => { const logs=await TaskStore.records('timeLogs'); if(!logs.some(l=>l.client_id===b.client_id)) await TaskStore.saveRecord('timeLogs',b); } });
  let start = (location.hash.replace('#/', '') || 'tasks');
  if (start === 'dashboard') start = 'tasks';
  await go(views[start] ? start : 'tasks');
  refreshBadge();
  const flash = sessionStorage.getItem('tf_flash');
  if (flash) { sessionStorage.removeItem('tf_flash'); toast(flash); }
  pollReminders();
  setInterval(pollReminders, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollReminders(); });
}
boot().catch((e) => { view().innerHTML = `<div class="card glass empty">Couldn't start TaskFlow: ${esc(e.message)}</div>`; });
})();

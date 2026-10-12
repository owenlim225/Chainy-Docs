const API = ['127.0.0.1', 'localhost'].includes(location.hostname) ? 'http://127.0.0.1:8787' : 'https://chainy-kanban-sync.hainy.workers.dev';
const $ = s => document.querySelector(s);
const DAY = 86400000;
const STATUS = ['Todo', 'In Progress', 'Done'];
const labelStatus = s => ({ Todo: 'To do', 'In Progress': 'In progress', Done: 'Done' })[s] || s;
const shortDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
const addDays = (s, n) => new Date(Date.parse(s) + n * DAY).toISOString().slice(0, 10);
const initials = name => name.split(' ').map(n => n[0]).slice(0, 2).join('');
let token = sessionStorage.getItem('chainy-session'), me = null, state = null, view = 'board', selected = null, etag = null, saving = false, toastTimer, historyNext = null, taskHistoryNext = null;
let dragging = null, draggingTimeline = false, taskHistoryRequest = 0;
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  children.flat().filter(c => c !== null && c !== undefined).forEach(c => node.append(c.nodeType ? c : document.createTextNode(String(c))));
  return node;
}
function notify(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error-toast', error); $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 10000 : 4000); }
async function api(path, options = {}) {
  const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  let response;
  try { response = await fetch(API + path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('Could not reach the shared board. Check your connection and retry.'); }
  if (response.status === 304) return null;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') signOut(false);
    const e = new Error(data.error || 'The request could not be saved.'); e.status = response.status; throw e;
  }
  return { data, response };
}
function member(id) { return state?.members.find(m => m.username === id); }
function name(id) { return member(id)?.name.split(' ')[0] || id; }
function person(id) { const m = member(id); return el('span', { class: 'person' }, el('span', { class: 'avatar ' + id, 'aria-hidden': 'true' }, initials(m?.name || id)), name(id)); }
function currentTasks() {
  const q = $('#search').value.trim().toLowerCase(), owner = $('#person').value, involved = $('#involvement').value === 'all';
  return state.tasks.filter(t => t.deleted === (view === 'trash') && (!q || [t.title, t.description, t.acceptance, name(t.lead)].join(' ').toLowerCase().includes(q)) && (!owner || t.lead === owner || (involved && (t.support.includes(owner) || t.reviewer === owner)))).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}
function dependencyWarnings(task) {
  return task.dependencies.flatMap(id => {
    const other = state.tasks.find(t => t.id === id);
    if (!other || other.deleted) return ['Prerequisite is in Trash: ' + (other?.title || id)];
    const warnings = [];
    if (other.status !== 'Done') warnings.push('Waiting for: ' + other.title);
    if (other.end >= task.start) warnings.push('Dates overlap a prerequisite: ' + other.title);
    return warnings;
  });
}
function render() {
  if (!state || draggingTimeline) return;
  const tasks = currentTasks(), active = state.tasks.filter(t => !t.deleted);
  $('#summary').textContent = `${active.length} tasks · ${active.filter(t => t.status === 'In Progress').length} in progress · ${active.filter(t => t.status === 'Done').length} done`;
  $('#filters').hidden = view === 'history'; $('#period-label').hidden = view !== 'timeline';
  $('.tabs').querySelectorAll('button').forEach(b => b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('#view-help').textContent = ({ board: 'Drag a card to move or reorder it. Open a card to edit details, dates or status.', timeline: 'Drag a bar to shift dates. Drag either edge to resize. Open a task to enter exact dates.', history: 'Who changed what, where and when. Times are shown in Manila time.', trash: 'Deleted tasks stay here with their history. Open a task to restore it.' })[view];
  if (view === 'history') { renderHistory(); return; }
  if (view === 'timeline') { renderTimeline(tasks); return; }
  $('#content').replaceChildren();
  if (view === 'trash') { $('#content').append(tasks.length ? el('div', { class: 'trash-list' }, tasks.map(card)) : empty('Trash is empty', 'Deleted cards can be restored here.')); return; }
  const board = el('div', { class: 'board' });
  for (const status of STATUS) {
    const cards = tasks.filter(t => t.status === status);
    const column = el('section', { class: 'column', 'data-status': status, 'aria-label': labelStatus(status) });
    column.append(el('div', { class: 'column-heading' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('h2', {}, labelStatus(status)), el('span', { class: 'count' }, cards.length), el('button', { 'aria-label': 'Add task to ' + labelStatus(status), onclick: () => openTask(null, status) }, '+')));
    column.append(...cards.map(card));
    if (!cards.length) column.append(el('p', { class: 'column-empty' }, tasks.length ? 'Drop a task here, or add a new one.' : 'No matching tasks. Try another person or search.'));
    column.addEventListener('dragover', e => { if (!dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; column.classList.add('drop-target'); document.querySelectorAll('.drop-before').forEach(n => n.classList.remove('drop-before')); const target = e.target.closest('.task-card'); if (target && target.dataset.id !== dragging) target.classList.add('drop-before'); });
    column.addEventListener('dragleave', e => { if (!column.contains(e.relatedTarget)) column.classList.remove('drop-target'); });
    column.addEventListener('drop', async e => {
      e.preventDefault(); column.classList.remove('drop-target'); document.querySelectorAll('.drop-before').forEach(n => n.classList.remove('drop-before')); if (!dragging || saving) return;
      const task = state.tasks.find(t => t.id === dragging); dragging = null;
      const target = e.target.closest('.task-card'); const before = target ? state.tasks.find(t => t.id === target.dataset.id) : null;
      if (!task || before?.id === task.id) return;
      const all = state.tasks.filter(t => !t.deleted && t.status === status && t.id !== task.id).sort((a, b) => a.position - b.position);
      const index = before ? all.findIndex(t => t.id === before.id) : all.length;
      const position = index === 0 ? (all[0]?.position ?? 1000) - 1000 : index === all.length ? (all.at(-1)?.position ?? 0) + 1000 : (all[index - 1].position + all[index].position) / 2;
      await quickSave(task, { status, position }, 'board', `Moved to ${labelStatus(status)}.`);
    });
    board.append(column);
  }
  $('#content').append(board);
}
function empty(title, message) { return el('div', { class: 'empty' }, el('h2', {}, title), el('p', {}, message)); }
function card(task) {
  const button = el('button', { class: 'task-card', 'data-id': task.id, draggable: String(!task.deleted), onclick: () => openTask(task) }, el('span', { class: 'card-title' }, task.title), el('span', { class: 'card-footer' }, person(task.lead), el('span', { class: 'card-date' }, `${shortDate(task.start)} – ${shortDate(task.end)}`)));
  const waiting = dependencyWarnings(task).length; if (waiting && task.status !== 'Done') button.append(el('span', { class: 'card-note' }, 'Prerequisites to check'));
  button.addEventListener('dragstart', e => { dragging = task.id; e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; button.classList.add('dragging'); });
  button.addEventListener('dragend', () => { dragging = null; button.classList.remove('dragging'); document.querySelectorAll('.drop-target,.drop-before').forEach(n => { n.classList.remove('drop-target'); n.classList.remove('drop-before'); }); });
  return button;
}
function renderTimeline(tasks) {
  const all = $('#period').value === 'all', start = all ? tasks.reduce((d, t) => t.start < d ? t.start : d, '2026-10-12') : '2026-10-12', finish = all ? tasks.reduce((d, t) => t.end > d ? t.end : d, '2027-04-09') : '2026-11-22';
  const count = dayDiff(finish, start) + 1, width = all ? 13 : 30, total = count * width;
  const timeline = el('div', { class: 'timeline' }); timeline.style.setProperty('--day-width', width + 'px');
  const days = el('div', { class: 'timeline-days' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (let i = 0; i < count; i++) { const d = addDays(start, i), date = new Date(d), weekend = [0, 6].includes(date.getUTCDay()); days.append(el('div', { class: `day${weekend ? ' weekend' : ''}${d === today ? ' today' : ''}`, title: shortDate(d) }, !all || date.getUTCDate() === 1 ? date.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }) : '', el('span', {}, !all || i % 7 === 0 ? date.getUTCDate() : ''))); }
  timeline.append(el('div', { class: 'timeline-head' }, el('div', { class: 'timeline-label' }, 'Task / lead'), days));
  const events = el('div', { class: 'timeline-track' }); events.style.width = total + 'px';
  state.milestones.forEach((m, index) => { if (m.start > finish || m.end < start) return; const n = el('div', { class: 'event-marker' + (index ? ' defense' : ''), title: m.title + ' · fixed' }, m.title); n.style.left = dayDiff(m.start, start) * width + 'px'; n.style.width = (dayDiff(m.end, m.start) + 1) * width + 'px'; events.append(n); });
  timeline.append(el('div', { class: 'timeline-events' }, el('div', { class: 'timeline-label' }, 'Fixed school events'), events));
  const visible = tasks.filter(t => t.start <= finish && t.end >= start).sort((a, b) => a.start.localeCompare(b.start) || a.position - b.position);
  visible.forEach(task => {
    const track = el('div', { class: 'timeline-track' }); track.style.width = total + 'px';
    const clippedStart = task.start < start ? start : task.start, clippedEnd = task.end > finish ? finish : task.end;
    const bar = el('div', { class: `bar ${task.lead}${task.status === 'Done' ? ' done' : ''}`, role: 'button', tabindex: '0', 'aria-label': `${task.title}, ${shortDate(task.start)} to ${shortDate(task.end)}. Open to edit dates.`, title: `${shortDate(task.start)} – ${shortDate(task.end)}` }, el('span', { class: 'resize-handle start', 'data-edge': 'start', title: 'Drag to change start' }), el('span', { class: 'bar-label' }, `${shortDate(task.start)} – ${shortDate(task.end)}`), el('span', { class: 'resize-handle end', 'data-edge': 'end', title: 'Drag to change finish' }));
    bar.style.left = dayDiff(clippedStart, start) * width + 'px'; bar.style.width = (dayDiff(clippedEnd, clippedStart) + 1) * width + 'px';
    bar.addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); openTask(task); } });
    bar.addEventListener('pointerdown', e => {
      if (saving || e.button !== 0) return;
      const edge = e.target.dataset.edge, fromX = e.clientX; let delta = 0, nextStart = task.start, nextEnd = task.end;
      const originalLeft = bar.style.left, originalWidth = bar.style.width;
      bar.setPointerCapture(e.pointerId); draggingTimeline = true;
      const move = ev => { delta = Math.round((ev.clientX - fromX) / width); nextStart = edge === 'end' ? task.start : addDays(task.start, delta); nextEnd = edge === 'start' ? task.end : addDays(task.end, delta); if (nextStart > nextEnd) { if (edge === 'start') nextStart = nextEnd; else nextEnd = nextStart; } bar.classList.add('drag-active'); bar.style.left = dayDiff(nextStart, start) * width + 'px'; bar.style.width = (dayDiff(nextEnd, nextStart) + 1) * width + 'px'; bar.querySelector('.bar-label').textContent = `${shortDate(nextStart)} – ${shortDate(nextEnd)}`; };
      const cleanup = () => { draggingTimeline = false; bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', end); bar.removeEventListener('pointercancel', cancel); bar.classList.remove('drag-active'); };
      const cancel = () => { cleanup(); bar.style.left = originalLeft; bar.style.width = originalWidth; render(); };
      const end = async () => { cleanup(); if (delta === 0) { openTask(task); return; } await quickSave(task, { start: nextStart, end: nextEnd }, 'timeline', `Dates saved: ${shortDate(nextStart)} – ${shortDate(nextEnd)}.`); };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', cancel);
    });
    track.append(bar);
    timeline.append(el('div', { class: 'timeline-row' }, el('button', { class: 'timeline-label', onclick: () => openTask(task) }, task.title, person(task.lead)), track));
  });
  const oldScroll = $('.timeline-wrap')?.scrollLeft || 0;
  const wrapper = el('div', { class: 'timeline-wrap', tabindex: '0', 'aria-label': 'Scrollable Gantt timeline' }, timeline);
  $('#content').replaceChildren(visible.length ? wrapper : empty('No tasks in this time window', 'Try the whole-project schedule or another filter.'), el('p', { class: 'timeline-note' }, `${visible.length} tasks shown. ${all ? 'Whole-project planning dates.' : 'October 12–November 22. Choose Whole project to see later work.'} Colors identify leads; gray bars are done. Prerequisites are listed inside each task.`));
  wrapper.scrollLeft = oldScroll;
}
async function quickSave(task, changes, surface, message) {
  if (saving) return; saving = true; $('#connection').textContent = 'Saving…';
  try { await api('/api/tasks/' + task.id, { method: 'PATCH', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { ...changes, version: task.version, surface } }); await refresh(true); notify(message); }
  catch (e) { notify(e.message, true); await refresh(true); }
  finally { saving = false; render(); }
}
function fillMembers() {
  const filter = $('#person'), previous = filter.value; filter.replaceChildren(el('option', { value: '' }, 'Everyone'));
  for (const m of state.members) filter.append(el('option', { value: m.username }, m.name.split(' ')[0] + ' · ' + m.role)); filter.value = previous;
  for (const field of ['lead', 'reviewer']) { const select = $('#task-form').elements[field]; select.replaceChildren(...state.members.map(m => el('option', { value: m.username }, m.name.split(' ')[0] + ' · ' + m.role))); }
}
function openTask(task, status = 'Todo') {
  selected = task ? { ...task } : null; const form = $('#task-form'); form.reset(); delete form.dataset.fingerprint;
  const initial = task || { title: '', description: '', acceptance: '', evidence: '', lead: me, reviewer: me === 'sherwin' ? 'christian' : 'sherwin', status, start: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }), end: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }), support: [], dependencies: [] };
  for (const field of ['title', 'description', 'acceptance', 'evidence', 'lead', 'reviewer', 'status', 'start', 'end']) form.elements[field].value = initial[field];
  fillOrder();
  $('#detail-heading').textContent = task?.deleted ? 'Deleted task' : task ? 'Task details' : 'Add a task';
  $('#support-options').replaceChildren(...state.members.map(m => { const input = el('input', { type: 'checkbox', name: 'support', value: m.username }); input.checked = initial.support.includes(m.username); return el('label', {}, input, m.name.split(' ')[0]); }));
  $('#dependency-options').replaceChildren(...state.tasks.filter(t => !t.deleted && t.id !== task?.id).sort((a, b) => a.title.localeCompare(b.title)).map(t => { const input = el('input', { type: 'checkbox', name: 'dependencies', value: t.id }); input.checked = initial.dependencies.includes(t.id); return el('label', {}, input, t.title); }));
  // Keep deleted prerequisites visible so an unrelated edit cannot silently remove them.
  initial.dependencies.filter(id => state.tasks.find(t => t.id === id)?.deleted).forEach(id => { const input = el('input', { type: 'checkbox', name: 'dependencies', value: id }); input.checked = true; $('#dependency-options').append(el('label', {}, input, (state.tasks.find(t => t.id === id)?.title || id) + ' (in Trash — restore or remove this prerequisite)')); });
  $('#task-error').textContent = ''; $('#save-task').hidden = Boolean(task?.deleted); $('#delete-task').hidden = !task || task.deleted; $('#restore-task').hidden = !task?.deleted;
  [...form.querySelectorAll('input,select,textarea')].forEach(n => n.disabled = Boolean(task?.deleted));
  $('#issue-link').hidden = !task?.issueNumber; if (task?.issueNumber) $('#issue-link').href = 'https://github.com/Kamiyon-Studio/Chainy/issues/' + task.issueNumber;
  const warnings = task ? dependencyWarnings(task) : []; $('#task-warning').hidden = !warnings.length; $('#task-warning').textContent = warnings.join(' · ');
  $('#task-history').replaceChildren(el('p', { class: 'quiet' }, task ? 'Loading history…' : 'History begins when this task is created.')); $('#more-task-history').hidden = true;
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
  if (task) loadTaskHistory(task.id); else taskHistoryRequest++;
}
function values(form) { const data = Object.fromEntries(new FormData(form)); data.support = new FormData(form).getAll('support'); data.dependencies = new FormData(form).getAll('dependencies'); return data; }
function fillOrder() {
  const form = $('#task-form'); const tasks = state.tasks.filter(t => !t.deleted && t.id !== selected?.id && t.status === form.elements.status.value).sort((a, b) => a.position - b.position);
  form.elements.order.replaceChildren(el('option', { value: 'keep' }, 'Keep current position'), el('option', { value: 'first' }, 'Move to top'), el('option', { value: 'last' }, 'Move to bottom'), ...tasks.map(t => el('option', { value: t.id }, 'Place before: ' + t.title)));
}
$('#task-form').elements.status.addEventListener('change', fillOrder);
$('#task-form').addEventListener('submit', async e => {
  e.preventDefault(); if (saving) return; saving = true; $('#save-task').disabled = true;
  const data = values(e.target); data.surface = 'details'; if (selected) data.version = selected.version;
  if (data.order !== 'keep') {
    const tasks = state.tasks.filter(t => !t.deleted && t.id !== selected?.id && t.status === data.status).sort((a, b) => a.position - b.position);
    const index = data.order === 'first' ? 0 : data.order === 'last' ? tasks.length : tasks.findIndex(t => t.id === data.order);
    data.position = index <= 0 ? (tasks[0]?.position ?? 1000) - 1000 : index === tasks.length ? (tasks.at(-1)?.position ?? 0) + 1000 : (tasks[index - 1].position + tasks[index].position) / 2;
  }
  delete data.order;
  if (data.start > data.end) { $('#task-error').textContent = 'Finish date must be on or after the start date.'; saving = false; $('#save-task').disabled = false; return; }
  // Keep a request identifier across retries of the exact same submitted data.
  const fingerprint = JSON.stringify(data); if (e.target.dataset.fingerprint !== fingerprint) { e.target.dataset.fingerprint = fingerprint; e.target.dataset.operation = crypto.randomUUID(); }
  try { await api('/api/tasks' + (selected ? '/' + selected.id : ''), { method: selected ? 'PATCH' : 'POST', headers: { 'Idempotency-Key': e.target.dataset.operation }, body: data }); $('#task-dialog').close(); delete e.target.dataset.fingerprint; await refresh(true); notify(selected ? 'Task saved.' : 'Task added.'); }
  catch (err) { $('#task-error').textContent = err.message; }
  finally { saving = false; $('#save-task').disabled = false; }
});
$('#close-task').onclick = () => { if (!saving) $('#task-dialog').close(); };
$('#task-dialog').addEventListener('cancel', e => { if (saving) e.preventDefault(); });
async function deleteRestore(restore) {
  if (!selected || saving) return;
  if (!restore && !confirm(`Move “${selected.title}” to Trash? Its history will be kept, and anyone can restore it.`)) return;
  saving = true;
  try { await api('/api/tasks/' + selected.id + (restore ? '/restore' : ''), { method: restore ? 'POST' : 'DELETE', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { version: selected.version, surface: restore ? 'trash' : 'details' } }); $('#task-dialog').close(); await refresh(true); notify(restore ? 'Task restored.' : 'Task moved to Trash.'); }
  catch (e) { $('#task-error').textContent = e.message; } finally { saving = false; }
}
$('#delete-task').onclick = () => deleteRestore(false); $('#restore-task').onclick = () => deleteRestore(true);
const fieldLabels = { title: 'Task name', description: 'Description', acceptance: 'Done when', evidence: 'Evidence / updates', lead: 'Lead', support: 'Support', reviewer: 'Reviewer', status: 'Status', start: 'Start date', end: 'Finish date', dependencies: 'Must finish first', position: 'Card order', deleted: 'In Trash' };
function changeValue(key, value) {
  if (value === null || value === '') return 'empty';
  if (key === 'dependencies') return value.map(id => state.tasks.find(t => t.id === id)?.title || id).join(', ') || 'none';
  if (key === 'support') return value.map(name).join(', ') || 'none';
  if (key === 'lead' || key === 'reviewer') return name(value);
  if (key === 'status') return labelStatus(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
function historyEntry(entry) {
  const n = el('article', { class: 'history-entry' });
  n.append(el('header', {}, member(entry.actor) ? person(entry.actor) : el('strong', {}, entry.actor), entry.action, el('time', { datetime: entry.at }, new Date(entry.at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', year: 'numeric' }))));
  const task = state.tasks.find(t => t.id === entry.task_id);
  n.append(el('p', {}, task ? el('button', { type: 'button', onclick: () => openTask(task) }, entry.title) : entry.title), el('div', { class: 'surface' }, 'Where: ' + ({ board: 'Board', timeline: 'Timeline', details: 'Task details', trash: 'Trash', migration: 'Project setup', account: 'Account settings' }[entry.surface] || entry.surface)));
  const details = Object.entries(entry.changes).map(([key, change]) => typeof change === 'object' && change !== null && 'to' in change ? el('li', {}, key === 'position' ? 'Card order changed.' : `${fieldLabels[key] || key}: ${changeValue(key, change.from)} → ${changeValue(key, change.to)}`) : el('li', {}, String(change)));
  if (details.length) n.append(el('details', {}, el('summary', {}, 'See changes'), el('ul', {}, details)));
  return n;
}
async function renderHistory(append = false) {
  if (!append) $('#content').replaceChildren(el('p', { class: 'quiet' }, 'Loading team history…'));
  try { const { data } = await api('/api/history' + (append && historyNext ? '?before=' + historyNext : '')); if (view !== 'history') return; historyNext = data.next; let list = $('#content .history-list'); if (!append || !list) { list = el('div', { class: 'history-list' }); $('#content').replaceChildren(list); } list.append(...data.entries.map(historyEntry)); if (!list.children.length) list.append(empty('No changes yet', 'The team’s saved changes will appear here.')); $('#load-history')?.remove(); if (historyNext) $('#content').append(el('button', { id: 'load-history', onclick: () => renderHistory(true) }, 'Load earlier changes')); }
  catch (e) { $('#content').replaceChildren(empty('History could not load', e.message)); }
}
async function loadTaskHistory(id, append = false) {
  const request = ++taskHistoryRequest;
  try { const { data } = await api('/api/history?task=' + encodeURIComponent(id) + (append && taskHistoryNext ? '&before=' + taskHistoryNext : '')); if (request !== taskHistoryRequest || selected?.id !== id) return; taskHistoryNext = data.next; if (!append) $('#task-history').replaceChildren(); $('#task-history').append(...data.entries.map(historyEntry)); $('#more-task-history').hidden = !taskHistoryNext; }
  catch (e) { if (selected?.id === id) $('#task-history').replaceChildren(el('p', { class: 'error' }, e.message)); }
}
$('#more-task-history').onclick = () => loadTaskHistory(selected.id, true);
async function refresh(force = false) {
  if (!token || draggingTimeline || dragging) return;
  try {
    const result = await api('/api/board', { headers: force ? {} : etag ? { 'If-None-Match': etag } : {} });
    if (result) { const first = !state; state = result.data; etag = result.response.headers.get('etag'); me = state.user; if (first) fillMembers(); if (view !== 'history' || force || first) render(); }
    $('#connection').classList.remove('offline');
    const failed = state?.sync.some(job => job.attempts > 0); $('#connection').textContent = failed ? 'Board saved · GitHub copy retrying' : state?.sync.length ? 'Shared board saved · GitHub copy pending' : 'Up to date · checks every 10 seconds';
    if (state) { $('#login-screen').hidden = true; $('#app').hidden = false; $('#account').hidden = false; $('#logout').hidden = false; $('#account').textContent = name(me); $('#account').title = 'Change your password'; }
  } catch (e) { if (e.status === 403 && token && !state) { showPassword(true); return; } $('#connection').textContent = 'Offline · changes are not saved'; $('#connection').classList.add('offline'); if (force) notify(e.message, true); if (!state && e.status !== 401) $('#login-error').textContent = e.message; }
}
async function signOut(remote = true) { if (remote && token) { try { await api('/api/logout', { method: 'POST' }); } catch { /* The local session is cleared even if the network is unavailable. */ } } token = null; sessionStorage.removeItem('chainy-session'); state = null; etag = null; me = null; $('#app').hidden = true; $('#login-screen').hidden = false; $('#account').hidden = true; $('#logout').hidden = true; $('#task-dialog').close(); $('#password-dialog').close(); $('#login-form').reset(); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true; button.textContent = 'Signing in…'; $('#login-error').textContent = '';
  try { const { data } = await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); token = data.token; sessionStorage.setItem('chainy-session', token); me = data.user.username; if (data.user.mustChange) showPassword(true); else await refresh(true); }
  catch (err) { $('#login-error').textContent = err.message; } finally { button.disabled = false; button.textContent = 'Sign in'; }
});
function showPassword(required = false) { $('#password-form').reset(); $('#password-error').textContent = ''; $('#password-heading').textContent = required ? 'Set your own password' : 'Change your password'; $('#password-dialog').dataset.required = String(required); $('#cancel-password').textContent = required ? 'Sign out' : 'Cancel'; $('#password-dialog').showModal(); }
$('#password-form').addEventListener('submit', async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target)); if (data.newPassword !== data.repeatPassword) { $('#password-error').textContent = 'The new passwords do not match.'; return; } const b = e.target.querySelector('[type=submit]'); b.disabled = true; try { await api('/api/password', { method: 'POST', body: data }); $('#password-dialog').close(); $('#login-form').reset(); await refresh(true); notify('Your password is saved.'); } catch (err) { $('#password-error').textContent = err.message; } finally { b.disabled = false; } });
$('#password-dialog').addEventListener('cancel', e => { if ($('#password-dialog').dataset.required === 'true') { e.preventDefault(); signOut(); } });
$('#cancel-password').onclick = () => $('#password-dialog').dataset.required === 'true' ? signOut() : $('#password-dialog').close();
$('#account').onclick = () => showPassword(); $('#logout').onclick = () => signOut(); $('#refresh').onclick = () => refresh(true); $('#add-task').onclick = () => openTask();
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
for (const id of ['search', 'person', 'involvement', 'period']) $('#' + id).addEventListener(id === 'search' ? 'input' : 'change', render);
$('#my-tasks').onclick = () => { $('#person').value = me; $('#involvement').value = 'lead'; render(); };
$('#export').onclick = async () => { try { const { data } = await api('/api/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = el('a', { href: url, download: 'chainy-board-' + new Date().toISOString().slice(0, 10) + '.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Board and history backup downloaded.'); } catch (e) { notify(e.message, true); } };
setInterval(() => { if (!document.hidden && !saving && view !== 'history') refresh(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if (token) refresh(true);

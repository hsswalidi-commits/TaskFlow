/* IndexedDB task persistence. SQLite remains available for legacy features and migration. */
(() => {
  'use strict';
  const DB_NAME = 'taskflow', DB_VERSION = 2, STORE = 'tasks';
  let dbPromise;
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('taskflow-tasks') : null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('status', 'status'); s.createIndex('due_at', 'due_at');
          s.createIndex('priority', 'priority'); s.createIndex('parent_id', 'parent_id');
          s.createIndex('deleted_at', 'deleted_at'); s.createIndex('updated_at', 'updated_at');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        for (const name of ['projects','events','reminders','timeLogs','settings','proposals','conversations']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, {keyPath:'id'});
        }
      };
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => reject(req.error || new Error('Could not open task database'));
      req.onblocked = () => reject(new Error('Task database upgrade is blocked by another tab'));
    });
    return dbPromise;
  }
  function tx(store, mode, action) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), s = t.objectStore(store); let result;
      try { result = action(s, t); } catch (e) { t.abort(); reject(e); return; }
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error || new Error('Task database transaction failed'));
    }));
  }
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = () => new Date().toISOString();
  const notify = () => channel && channel.postMessage({ type: 'changed' });
  function normalize(input, old) {
    const stamp = now();
    return { ...old, ...input, id: old ? old.id : (input.id || uuid()),
      title: String(input.title || '').trim(), notes: String(input.notes || ''),
      status: input.status || 'todo', priority: Number(input.priority || 2),
      due_at: input.due_at || null, tags: Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(',').map(x => x.trim()).filter(Boolean),
      recurrence: input.recurrence || 'none', project_id: input.project_id || null,
      parent_id: input.parent_id || null, position: Number(input.position || 0),
      created_at: old?.created_at || input.created_at || stamp, updated_at: stamp,
      completed_at: input.status === 'done' ? (old?.completed_at || stamp) : null,
      deleted_at: input.deleted_at || null, version: (old?.version || 0) + 1,
      subtasks: input.subtasks || old?.subtasks || [] };
  }
  const requestValue = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  async function list(options = {}) {
    const records = await tx(STORE, 'readonly', s => requestValue(s.getAll()));
    let rows = records.filter(t => options.trash ? !!t.deleted_at : !t.deleted_at);
    if (options.project) rows = rows.filter(t => String(t.project_id || '') === String(options.project));
    if (options.status && options.status !== 'all') rows = rows.filter(t => options.status === 'open' ? t.status !== 'done' : t.status === options.status);
    if (options.priority) rows = rows.filter(t => String(t.priority) === String(options.priority));
    if (options.due === 'none') rows = rows.filter(t => !t.due_at);
    if (options.due === 'overdue') rows = rows.filter(t => t.due_at && new Date(t.due_at) < new Date() && t.status !== 'done');
    if (options.due === 'today') rows = rows.filter(t => t.due_at && new Date(t.due_at).toDateString() === new Date().toDateString());
    if (options.due === 'week') rows = rows.filter(t => t.due_at && new Date(t.due_at) <= new Date(Date.now() + 7 * 86400000));
    const q = String(options.q || '').toLowerCase();
    if (q) rows = rows.filter(t => `${t.title} ${t.notes} ${(t.tags || []).join(' ')}`.toLowerCase().includes(q) || (t.subtasks || []).some(x => x.title.toLowerCase().includes(q)));
    const far = '9999';
    rows.sort((a,b) => options.sort === 'priority' ? b.priority-a.priority : options.sort === 'created' ? b.created_at.localeCompare(a.created_at) : options.sort === 'due' ? (a.due_at||far).localeCompare(b.due_at||far) : (a.status==='done')-(b.status==='done') || (a.due_at||far).localeCompare(b.due_at||far) || b.priority-a.priority);
    const children = records.filter(t => !t.deleted_at && t.parent_id);
    return rows.filter(t => !t.parent_id).map(t => ({...t, subtasks: children.filter(s => s.parent_id === t.id).sort((a,b) => a.position-b.position)}));
  }
  async function get(id) { return tx(STORE, 'readonly', s => requestValue(s.get(id))); }
  async function create(input) {
    if (!String(input.title || '').trim()) throw new Error('Task title is required');
    const row = normalize(input); row.position = row.position || Date.now();
    await tx(STORE, 'readwrite', s => s.add(row)); notify(); return row;
  }
  async function update(id, fields, expectedVersion) {
    const db = await open();
    const next = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite'), s = t.objectStore(STORE); let updated;
      const r = s.get(id);
      r.onsuccess = () => {
        const row = r.result;
        if (!row) { t.abort(); reject(new Error('Task not found')); return; }
        if (expectedVersion != null && row.version !== expectedVersion) { t.abort(); reject(new Error('Task changed in another tab; reload and try again')); return; }
        updated = normalize({...row, ...fields}, row);
        s.put(updated);
      };
      t.oncomplete = () => resolve(updated);
      t.onerror = t.onabort = () => reject(t.error || new Error('Task update failed'));
    });
    notify(); return next;
  }
  async function remove(id) { const row = await get(id); if (!row) throw new Error('Task not found'); await update(id, {deleted_at: now()}); const subs = (await list({status:'all'})).flatMap(t=>t.subtasks||[]).filter(t=>t.parent_id===id); for (const s of subs) await update(s.id,{deleted_at:now()}); }
  async function restore(id) { const row = await get(id); if (!row) throw new Error('Task not found'); await update(id,{deleted_at:null}); const all = await tx(STORE,'readonly',s=>requestValue(s.getAll())); for (const child of all.filter(t=>t.parent_id===id&&t.deleted_at)) await update(child.id,{deleted_at:null}); }
  async function purge(id) { await tx(STORE,'readwrite',s=>{s.delete(id); const r=s.openCursor(); r.onsuccess=()=>{const c=r.result;if(c){if(c.value.parent_id===id)c.delete();c.continue();}};}); notify(); }
  async function bulk(ids, action, value) {
    const all = await tx(STORE,'readonly',s=>requestValue(s.getAll())); const targets=all.filter(t=>ids.includes(t.id)&&!t.deleted_at);
    await tx(STORE,'readwrite',s=>targets.forEach(t=>{ const fields = action==='delete'?{deleted_at:now()}:action==='priority'?{priority:Number(value)}:action==='project'?{project_id:value||null}:{status:action==='done'?'done':action}; s.put(normalize({...t,...fields},t)); })); notify(); return targets.length;
  }
  async function clearDone() { const rows=await list({status:'done'}); for(const t of rows) await remove(t.id); return rows.length; }
  async function records(name) { if (!['projects','events','reminders','timeLogs','settings','proposals','conversations'].includes(name)) throw new Error('Unknown local store'); return tx(name,'readonly',s=>requestValue(s.getAll())); }
  async function saveRecord(name, value) { if (!['projects','events','reminders','timeLogs','settings','proposals','conversations'].includes(name)) throw new Error('Unknown local store'); const row={...value,id:value.id||uuid(),updated_at:now()}; await tx(name,'readwrite',s=>s.put(row)); notify(); return row; }
  async function deleteRecord(name,id) { if (!['projects','events','reminders','timeLogs','settings','proposals','conversations'].includes(name)) throw new Error('Unknown local store'); await tx(name,'readwrite',s=>s.delete(id)); notify(); }
  async function initializeDefaults() {
    await open();
    const defaults = {
      id:'local', name:'', tz_offset:-new Date().getTimezoneOffset(), work_start:540, work_end:1080,
      quiet_start:1320, quiet_end:420, remind_lead:30, pomo_work:25, pomo_short:5,
      pomo_long:15, pomo_cycles:4, created_at:now(), updated_at:now()
    };
    await tx('settings','readwrite',s=>{ const r=s.get('local'); r.onsuccess=()=>{if(!r.result)s.add(defaults);}; });
    const settings = await records('settings');
    const localSettings=settings.find(x=>x.id==='local')||defaults;
    for (const store of ['projects','events','reminders','timeLogs','proposals','conversations']) await records(store);
    return {settings:localSettings};
  }
  async function importLegacyBundle(bundle) {
    const marker=await tx('meta','readonly',s=>requestValue(s.get('legacy-module-import-v1')));
    if(marker?.done)return {imported:false};
    const maps={projects:bundle.projects||[],reminders:bundle.reminders||[],timeLogs:bundle.timeLogs||[],proposals:bundle.proposals||[]};
    let count=0;
    for(const [store,items] of Object.entries(maps)){
      const existing=await records(store), seen=new Set(existing.map(x=>String(x.legacy_id||x.id)));
      for(const item of items){if(seen.has(String(item.id)))continue; await saveRecord(store,{...item,legacy_id:item.id,id:uuid(),source:'legacy'});count++;}
    }
    const local=(bundle.settings&&typeof bundle.settings==='object')?bundle.settings:null;
    if(local){const current=(await records('settings')).find(x=>x.id==='local'); if(current&&!current.legacy_imported)await saveRecord('settings',{...current,...local,id:'local',legacy_imported:true});}
    await tx('meta','readwrite',s=>s.put({key:'legacy-module-import-v1',done:true,count,completedAt:now()}));
    return {imported:true,count};
  }
  async function migrate() {
    const marker = await tx('meta','readonly',s=>requestValue(s.get('sqlite-migration-v1')));
    if (marker?.done) return {migrated:false};
    const existing = await tx(STORE,'readonly',s=>requestValue(s.count()));
    if (existing) return {migrated:false, conflict:true};
    const migrationResponse=await fetch('/api/tasks/migration-export',{credentials:'same-origin'});
    if(migrationResponse.status===401||migrationResponse.status===404)return {migrated:false,legacyUnavailable:true};
    if(!migrationResponse.ok)throw new Error(`Legacy task export failed (${migrationResponse.status})`);
    const {tasks}=await migrationResponse.json();
    const idMap=new Map(tasks.map(t=>[String(t.id),uuid()]));
    const records=[];
    for(const t of tasks) { const row=normalize({...t,id:idMap.get(String(t.id)),parent_id:t.parent_id?idMap.get(String(t.parent_id)):null, deleted_at:t.deleted_at||null},null); row.created_at=t.created_at; row.updated_at=t.updated_at||t.created_at; row.completed_at=t.completed_at; row.position=t.position||0; row.version=1; records.push(row); }
    await tx(STORE,'readwrite',s=>records.forEach(t=>s.add(t)));
    const verify=await tx(STORE,'readonly',s=>requestValue(s.count()));
    if(verify!==records.length) { await tx(STORE,'readwrite',s=>records.forEach(t=>s.delete(t.id))); throw new Error('Migration verification failed; legacy data remains available'); }
    await tx('meta','readwrite',s=>s.put({key:'sqlite-migration-v1',done:true,count:verify,completedAt:now()})); notify(); return {migrated:true,count:verify};
  }
  window.TaskStore={open,list,get,create,update,remove,restore,purge,bulk,clearDone,records,saveRecord,deleteRecord,initializeDefaults,importLegacyBundle,migrate,onChange(fn){if(channel)channel.onmessage=fn;}};
})();

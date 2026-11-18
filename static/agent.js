/* Shared browser-side Copilot request helper. Task snapshots stay in the browser
   until explicitly submitted for a single, temporary backend request. */
(() => {
  'use strict';
  let history = [];
  const memoryKey = 'taskflow-copilot-memory-v1';
  try { history = JSON.parse(localStorage.getItem(memoryKey) || '[]').slice(-12); } catch (_) { history = []; }
  window.TaskFlowAgent = {
    async send(message) {
      const tasks = await window.TaskStore.list({status:'all'});
      const response = await fetch('/api/chat', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({message, history, tasks, client_time:new Date().toISOString()})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Copilot request failed');
      history.push({role:'user',content:message},{role:'assistant',content:data.reply||''}); history=history.slice(-12);
      try { localStorage.setItem(memoryKey,JSON.stringify(history)); } catch (_) {}
      return data;
    },
    clearMemory() { history = []; try { localStorage.removeItem(memoryKey); } catch (_) {} },
    async confirmDeletions(items) {
      const current=await Promise.all(items.map(x=>window.TaskStore.get(x.id)));
      for(let i=0;i<items.length;i++)if(!current[i]||current[i].version!==(items[i].version||1))throw new Error('Task changed since the deletion preview; request a fresh confirmation.');
      for(const item of items)await window.TaskStore.remove(item.id);
    }
  };
})();

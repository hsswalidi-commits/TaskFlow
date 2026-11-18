/* Applies the saved sidebar state before first paint so the layout doesn't jump. */
try { if (localStorage.getItem('tf_sidebar_collapsed') === '1') document.documentElement.classList.add('sidebar-collapsed'); } catch (e) { /* storage unavailable */ }

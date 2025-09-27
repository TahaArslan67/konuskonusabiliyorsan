(function(){
  async function inject(){
    try{
      const el = document.createElement('div');
      const r = await fetch('/header.html', { cache:'no-cache' });
      el.innerHTML = await r.text();
      const hdr = el.firstElementChild; const mm = el.lastElementChild;
      const body = document.body; if (!body) return;
      // Insert at top of body
      body.insertBefore(hdr, body.firstChild);
      body.insertBefore(mm, hdr.nextSibling);
      // Helper to apply header state immediately
      function applyHeaderState(){
        try{
          const token = localStorage.getItem('hk_token');
          const btnLogin = document.getElementById('btnLogin');
          const btnAccount = document.getElementById('btnAccount');
          if (token){
            if (btnLogin) btnLogin.style.display = 'none';
            if (btnAccount) btnAccount.style.display = 'inline-flex';
          } else {
            if (btnLogin) btnLogin.style.display = 'inline-flex';
            if (btnAccount) btnAccount.style.display = 'none';
          }
        }catch{}
      }
      // Re-bind site controls (site.js expects these IDs)
      try{ if (window.updateHeader) window.updateHeader(); else applyHeaderState(); }catch{ applyHeaderState(); }
      // Re-apply on window load (module timing)
      window.addEventListener('load', () => { try{ if (window.updateHeader) window.updateHeader(); else applyHeaderState(); }catch{ applyHeaderState(); } });
      // Update when token changes in another tab
      window.addEventListener('storage', (e) => { if (e.key === 'hk_token') applyHeaderState(); });
      // Wire login button even if site.js hasn't loaded yet
      try{
        const btnLogin = document.getElementById('btnLogin');
        if (btnLogin){
          btnLogin.addEventListener('click', (ev) => {
            ev.preventDefault();
            try{ if (window.openAuth){ window.openAuth(); return; } }catch{}
            const redirect = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/?auth=1&redirect=${redirect}`;
          });
        }
        const btnAccount = document.getElementById('btnAccount');
        if (btnAccount){
          btnAccount.addEventListener('click', (ev) => {
            ev.preventDefault();
            const token = localStorage.getItem('hk_token');
            if (!token){
              const redirect = encodeURIComponent('/account.html');
              window.location.href = `/?auth=1&redirect=${redirect}`;
              return;
            }
            window.location.href = '/account.html';
          });
        }
        const btnStart = document.getElementById('btnStart');
        if (btnStart){
          btnStart.addEventListener('click', (ev) => {
            ev.preventDefault();
            const token = localStorage.getItem('hk_token');
            if (!token){ try{ window.setPostLoginRedirect && window.setPostLoginRedirect('/realtime.html'); window.openAuth && window.openAuth(); window.showLogin && window.showLogin(); }catch{}; return; }
            window.location.href = '/realtime.html';
          });
        }
      }catch{}
    }catch{}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();



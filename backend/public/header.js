(function(){
  async function inject(){
    try{
      const el = document.createElement('div');
      const r = await fetch('/header.html');
      el.innerHTML = await r.text();
      const hdr = el.firstElementChild; const mm = el.lastElementChild;
      const body = document.body; if (!body) return;
      // Insert at top of body
      body.insertBefore(hdr, body.firstChild);
      body.insertBefore(mm, hdr.nextSibling);
      // Dropdown CSS injector removed (no dropdown menu)
      // Helper to apply header state immediately
      function applyHeaderState(){
        try{
          const token = localStorage.getItem('hk_token');
          const btnLogin = document.getElementById('btnLogin');
          const btnAccount = document.getElementById('btnAccount');
          const navFeatures = document.getElementById('navFeatures');
          const navPricing = document.getElementById('navPricing');
          const mmFeatures = document.getElementById('mmFeatures');
          const mmPricing = document.getElementById('mmPricing');
          if (token){
            if (btnLogin) btnLogin.style.display = 'none';
            if (btnAccount) btnAccount.style.display = 'inline-flex';
            if (navFeatures) navFeatures.style.display = 'none';
            if (navPricing) navPricing.style.display = 'none';
            if (mmFeatures) mmFeatures.style.display = 'none';
            if (mmPricing) mmPricing.style.display = 'none';
          } else {
            if (btnLogin) btnLogin.style.display = 'inline-flex';
            if (btnAccount) btnAccount.style.display = 'none';
            if (navFeatures) navFeatures.style.display = '';
            if (navPricing) navPricing.style.display = '';
            if (mmFeatures) mmFeatures.style.display = '';
            if (mmPricing) mmPricing.style.display = '';
          }
        }catch{}
      }
      // Re-bind site controls (site.js expects these IDs)
      try{ if (window.updateHeader) window.updateHeader(); else applyHeaderState(); }catch{ applyHeaderState(); }
      // Re-apply on window load (module timing)
      window.addEventListener('load', () => { try{ if (window.updateHeader) window.updateHeader(); else applyHeaderState(); }catch{ applyHeaderState(); } });
      // Update when token changes in another tab
      window.addEventListener('storage', (e) => { if (e.key === 'hk_token') applyHeaderState(); });
      // Mobile menu controls (works even if site.js not loaded)
      try{
        const btnMenu = document.getElementById('btnMenu');
        const mm = document.getElementById('mobileMenu');
        const mmLogin = document.getElementById('mmLogin');
        const mmAccount = document.getElementById('mmAccount');
        const mmStart = document.getElementById('mmStart');
        if (btnMenu && mm){
          const open = () => { mm.style.display = 'block'; document.body.style.overflow = 'hidden'; };
          const close = () => { mm.style.display = 'none'; document.body.style.overflow = ''; };
          btnMenu.addEventListener('click', () => { mm.style.display === 'block' ? close() : open(); });
          try{ mm.querySelectorAll('[data-mm-close]').forEach(el => el.addEventListener('click', close)); }catch{}
          window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
          if (mmLogin){ mmLogin.addEventListener('click', () => { close(); try{ window.openAuth && window.openAuth(); window.showLogin && window.showLogin(); }catch{} }); }
          if (mmAccount){ mmAccount.addEventListener('click', () => { close(); window.location.href = '/account.html'; }); }
          if (mmStart){ mmStart.addEventListener('click', (ev) => { ev.preventDefault(); close(); const t = localStorage.getItem('hk_token'); if (!t){ try{ window.setPostLoginRedirect && window.setPostLoginRedirect('/realtime.html'); window.openAuth && window.openAuth(); window.showLogin && window.showLogin(); }catch{} } else { window.location.href = '/realtime.html'; } }); }
          // mmOcr linki artık herkese açık, sayfa içinde buton seviyesinde login kontrolü yapılacak
        }
      }catch{}
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



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
      // Inject dropdown CSS once (keeps header.html with only two top-level elements)
      try{
        if (!document.getElementById('hdrDropdownCss')){
          const s = document.createElement('style');
          s.id = 'hdrDropdownCss';
          s.textContent = `
            .nav .dropdown{ position:relative; }
            .nav .dropdown > a{ display:inline-flex; align-items:center; gap:6px; }
            .nav .dropdown > a::after{ content:"▾"; font-size:10px; opacity:.7; }
            .dropdown-menu{ position:absolute; top:100%; left:0; display:none; min-width:200px; padding:8px; background:rgba(14,20,48,.98); border:1px solid rgba(124,58,237,.25); border-radius:10px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
            .dropdown-menu a{ display:block; padding:8px 10px; border-radius:8px; color:var(--muted); }
            .dropdown-menu a:hover{ background: rgba(124,58,237,.12); color:#fff; }
            .dropdown:hover .dropdown-menu{ display:block; }
            .dropdown-menu a.disabled{ opacity:.6; pointer-events:none; }
            @media (max-width: 640px){ .nav .dropdown .dropdown-menu{ display:none !important; } }
          `;
          document.head.appendChild(s);
        }
      }catch{}
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



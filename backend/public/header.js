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
      // Re-bind site controls (site.js expects these IDs)
      try{ if (window.updateHeader) window.updateHeader(); }catch{}
      // Wire login button even if site.js hasn't loaded yet
      try{
        const btnLogin = document.getElementById('btnLogin');
        if (btnLogin){
          btnLogin.addEventListener('click', (ev) => {
            ev.preventDefault();
            try{ if (window.openAuth){ openAuth(); return; } }catch{}
            const redirect = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/?auth=1&redirect=${redirect}`;
          });
        }
      }catch{}
    }catch{}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();



(function(){
  function inject(){
    try{
      fetch('/footer.html', { cache:'no-cache' })
        .then(r => r.text())
        .then(html => {
          const wrap = document.createElement('div');
          wrap.innerHTML = html;
          const el = wrap.firstElementChild;
          document.body.appendChild(el);
          var y = document.getElementById('year'); if (y) y.textContent = new Date().getFullYear();
        }).catch(()=>{});
    }catch{}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();



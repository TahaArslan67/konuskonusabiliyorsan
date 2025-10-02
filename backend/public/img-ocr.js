(function(){
  const statusEl = document.getElementById('status');
  const previews = document.getElementById('previews');
  const btn = document.getElementById('btnTranslate');
  const srcSel = document.getElementById('sourceLang');
  const dstSel = document.getElementById('targetLang');
  const textTR = document.getElementById('textTR');
  const textEN = document.getElementById('textEN');
  const copyEN = document.getElementById('btnCopyEN');
  const fileInput = document.getElementById('fileInput');
  const drop = document.getElementById('drop');

  const backendBase = (typeof window !== 'undefined' && window.__BACKEND_BASE__) ? window.__BACKEND_BASE__ : (window.location.origin);

  let images = [];
  function setStatus(msg){ if (statusEl) statusEl.textContent = msg || ''; }
  function resetUI(){
    previews.innerHTML = '';
    setStatus('');
    images = [];
    btn.disabled = true;
    copyEN.disabled = true;
    textTR.value = '';
    textEN.value = '';
  }

  function getSelectedLangName(sel){
    try{
      const opt = sel && sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      if (!opt) return (sel && sel.value) ? sel.value.toUpperCase() : 'Hedef';
      const txt = String(opt.textContent || '').trim();
      const idx = txt.lastIndexOf('(');
      return idx > 0 ? txt.slice(0, idx).trim() : txt;
    }catch{ return 'Hedef'; }
  }
  function updateCopyBtnLabel(){
    try{ const name = getSelectedLangName(dstSel); if (copyEN) copyEN.textContent = `${name} Metni Kopyala`; }catch{}
  }
  try{ updateCopyBtnLabel(); }catch{}
  try{ dstSel && dstSel.addEventListener('change', updateCopyBtnLabel); }catch{}

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); const files = Array.from(e.dataTransfer.files || []); handleFiles(files); });
  fileInput.addEventListener('change', () => handleFiles(Array.from(fileInput.files || [])));

  async function handleFiles(files){
    resetUI();
    if (!files || !files.length) return;
    setStatus('Görseller işleniyor...');
    const max = 10;
    for (const f of files.slice(0, max)){
      if (/^image\/(png|jpe?g)$/i.test(f.type)){
        const url = await fileToDataUrl(f);
        if (url) addImage(url, f.name || 'Görsel');
      }
      if (images.length >= max) break;
    }
    btn.disabled = images.length === 0;
    setStatus(images.length ? `${images.length} görsel hazır` : 'Geçerli görsel bulunamadı');
  }

  function addImage(url, label){
    images.push(url);
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img alt="${label}" src="${url}"/><small>${label}</small>`;
    previews.appendChild(div);
  }

  function fileToDataUrl(file){
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  btn.addEventListener('click', async () => {
    if (!images.length) return;
    btn.disabled = true;
    setStatus('Metin çıkarılıyor ve çevriliyor...');
    try{
      const token = localStorage.getItem('hk_token');
      if (!token){
        setStatus('Giriş gerekiyor, yönlendiriliyor...');
        const redirect = encodeURIComponent('/img-ocr');
        window.location.href = `/?auth=1&redirect=${redirect}`;
        btn.disabled = false;
        return;
      }
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
      const r = await fetch(`${backendBase}/api/ocr-translate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ images, sourceLang: srcSel.value || 'tr', targetLang: dstSel.value || 'en' })
      });
      if (!r.ok){
        let msg = `Hata: ${r.status}`;
        try{
          const j = await r.json();
          if (j?.error === 'limit_reached') setStatus(`Günlük OCR hakkınız doldu (${j.dailyUsed}/${j.dailyLimit}).`);
          else if (j?.error === 'unauthorized' || r.status === 401) setStatus('Devam etmek için giriş yapın.');
          else if (j?.error) setStatus(`Hata: ${j.error}`);
          else setStatus(msg);
        }catch{
          const t = await r.text(); setStatus(`${msg} ${t}`);
        }
        btn.disabled = false; return;
      }
      const j = await r.json();
      textTR.value = j.text_tr || '';
      textEN.value = j.text_en || '';
      copyEN.disabled = !(j.text_en && j.text_en.length);
      if (j.quota && typeof j.quota.dailyLimit === 'number' && typeof j.quota.dailyUsed === 'number'){
        const remain = Math.max(0, j.quota.dailyLimit - j.quota.dailyUsed);
        setStatus(`Tamamlandı • Kalan günlük hak: ${remain}/${j.quota.dailyLimit}`);
      } else setStatus('Tamamlandı');
    }catch(e){ console.error(e); setStatus('Sunucu hatası'); }
    finally{ btn.disabled = false; }
  });

  copyEN.addEventListener('click', async () => {
    try{ await navigator.clipboard.writeText(textEN.value || ''); setStatus('Kopyalandı'); }catch{ setStatus('Kopyalanamadı'); }
  });
})();

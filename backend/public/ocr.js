/* global pdfjsLib */
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

  // Configure pdf.js worker via CDN
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  } catch {}

  let images = []; // data URLs (image/png or image/jpeg)

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

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const files = Array.from(e.dataTransfer.files || []);
    handleFiles(files);
  });
  fileInput.addEventListener('change', () => handleFiles(Array.from(fileInput.files || [])));

  async function handleFiles(files){
    resetUI();
    if (!files || !files.length) return;
    setStatus('Dosyalar işleniyor...');
    const max = 10;

    for (const f of files.slice(0, max)){
      if (f.type === 'application/pdf'){
        await handlePdf(f, max - images.length);
      } else if (/^image\/(png|jpe?g)$/i.test(f.type)){
        const url = await fileToDataUrl(f);
        if (url) addImage(url, `Görsel`);
      }
      if (images.length >= max) break;
    }

    btn.disabled = images.length === 0;
    setStatus(images.length ? `${images.length} sayfa/görsel hazır` : 'Geçerli dosya bulunamadı');
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

  async function handlePdf(file, slots){
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pages = Math.min(pdf.numPages, slots);
      for (let i = 1; i <= pages; i++){
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
        const url = canvas.toDataURL('image/jpeg', 0.92);
        addImage(url, `PDF Sayfa ${i}`);
        // throttle
        await new Promise(r => setTimeout(r, 30));
      }
    } catch (e){
      console.error('PDF işleme hatası:', e);
      setStatus('PDF işlenirken hata oluştu.');
    }
  }

  btn.addEventListener('click', async () => {
    if (!images.length) return;
    btn.disabled = true;
    setStatus('Metin çıkarılıyor ve çevriliyor...');
    try{
      const r = await fetch(`${backendBase}/api/ocr-translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, sourceLang: srcSel.value || 'tr', targetLang: dstSel.value || 'en' })
      });
      if (!r.ok){
        const t = await r.text();
        setStatus(`Hata: ${r.status} ${t}`);
        btn.disabled = false;
        return;
      }
      const j = await r.json();
      textTR.value = j.text_tr || '';
      textEN.value = j.text_en || '';
      copyEN.disabled = !(j.text_en && j.text_en.length);
      setStatus('Tamamlandı');
    }catch(e){
      console.error(e);
      setStatus('Sunucu hatası');
    } finally {
      btn.disabled = false;
    }
  });

  copyEN.addEventListener('click', async () => {
    try{ await navigator.clipboard.writeText(textEN.value || ''); setStatus('Kopyalandı'); }catch{ setStatus('Kopyalanamadı'); }
  });
})();

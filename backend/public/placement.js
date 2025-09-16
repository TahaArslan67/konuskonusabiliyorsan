const backendBase = location.origin;
const quizEl = document.getElementById('quiz');
const statusEl = document.getElementById('status');
const btnSubmit = document.getElementById('btnSubmit');
const btnNext = document.getElementById('btnNext');
const learnLangSelect = document.getElementById('placementLearnLang');

let currentQuestions = [];
const levelOrder = ['A1','A2','B1','B2','C1','C2'];
let step = 0;
const maxSteps = 8;
let currentLevelIdx = 2; // start at B1
let usedIds = new Set();
let history = []; // { levelIdx, correct, qid }
let started = false; // start only after clicking 'Teste Başla'

function pickQuestionForLevel(idx){
  const lvl = levelOrder[Math.max(0, Math.min(levelOrder.length-1, idx))];
  let candidates = (currentQuestions || []).filter(q => q.level === lvl && !usedIds.has(q.id));
  if (!candidates.length){
    // fallback: try adjacent levels
    for (let delta of [1,-1,2,-2]){
      const alt = levelOrder[Math.max(0, Math.min(levelOrder.length-1, idx+delta))];
      candidates = (currentQuestions || []).filter(q => q.level === alt && !usedIds.has(q.id));
      if (candidates.length) break;
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function renderCurrentQuestion(){
  const quiz = document.getElementById('quiz');
  if (!quiz) return;
  quiz.innerHTML = '';
  const q = pickQuestionForLevel(currentLevelIdx);
  if (!q){
    // If pool exhausted, show submit
    if (btnNext) btnNext.style.display = 'none';
    if (btnSubmit) btnSubmit.style.display = 'inline-block';
    statusEl && (statusEl.textContent = 'Havuz tükendi, sonucu kaydedebilirsiniz.');
    return;
  }
  // Render one question
  const wrap = document.createElement('div');
  wrap.className = 'q';
  const h = document.createElement('h4');
  h.textContent = `${step+1}. ${q.text}`;
  wrap.appendChild(h);
  q.options.forEach((opt, i) => {
    const label = document.createElement('label');
    label.className = 'opt';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = q.id; input.value = String(i);
    label.appendChild(input);
    label.append(` ${opt}`);
    wrap.appendChild(label);
  });
  quiz.appendChild(wrap);
  // Attach id to container for retrieval
  quiz.dataset.qid = q.id;
  quiz.dataset.answer = String(q.answer);
}

function computeScore(){
  // Adaptive: derive final level from history of visited level indices with +/-0.5 weight
  let correctCount = 0;
  if (!history.length) return { correct: 0, total: 0, level: 'A1' };
  let sum = 0;
  history.forEach(h => { sum += (h.levelIdx + (h.correct ? 0.5 : -0.5)); if (h.correct) correctCount++; });
  const avg = sum / history.length;
  let idx = Math.round(Math.max(0, Math.min(levelOrder.length-1, avg)));
  const level = levelOrder[idx];
  return { correct: correctCount, total: history.length, level };
}

async function populateLearnLang(){
  if (!learnLangSelect) return;
  const langs = [
    { code: 'tr', name: 'Türkçe' }, { code: 'en', name: 'İngilizce' }, { code: 'de', name: 'Almanca' },
    { code: 'fr', name: 'Fransızca' }, { code: 'es', name: 'İspanyolca' }, { code: 'it', name: 'İtalyanca' },
    { code: 'pt', name: 'Portekizce' }, { code: 'ru', name: 'Rusça' }, { code: 'ar', name: 'Arapça' },
    { code: 'fa', name: 'Farsça' }, { code: 'hi', name: 'Hintçe' }, { code: 'zh-CN', name: 'Çince (Basit)' },
    { code: 'ja', name: 'Japonca' }, { code: 'ko', name: 'Korece' }
  ];
  // clear except placeholder
  learnLangSelect.innerHTML = '<option value="">(Seçiniz)</option>';
  langs.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.code; opt.textContent = `${l.name} (${l.code})`;
    learnLangSelect.appendChild(opt);
  });
  // default from /me
  try{
    const token = localStorage.getItem('hk_token');
    if (!token) return;
    const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` }});
    if (r.ok){
      const me = await r.json();
      const code = me?.preferredLearningLanguage || 'tr';
      const opt = Array.from(learnLangSelect.options).find(o => o.value === code);
      if (opt) opt.selected = true; else learnLangSelect.value = 'tr';
    }
  } catch {}
  // If a language is already selected (non-empty), auto-start by dispatching change
  if (learnLangSelect && learnLangSelect.value){
    // small timeout to ensure DOM ready
    setTimeout(() => {
      const evt = new Event('change');
      learnLangSelect.dispatchEvent(evt);
    }, 0);
  }
}

async function persistLearnLangIfChanged(){
  try{
    const code = learnLangSelect && learnLangSelect.value ? learnLangSelect.value : '';
    if (!code){ throw new Error('Lütfen hedef dili seçin'); }
    const token = localStorage.getItem('hk_token');
    if (!token) return;
    const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` }});
    let current = null; if (r.ok) { const me = await r.json(); current = me?.preferredLearningLanguage || null; }
    if (current !== code){
      await fetch(`${backendBase}/me/preferences`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ preferredLearningLanguage: code }) });
    }
  } catch (e){
    throw e;
  }
}

async function submitPlacement(){
  try {
    // enforce language selection
    const selectedLang = learnLangSelect && learnLangSelect.value ? learnLangSelect.value : '';
    if (!selectedLang){
      alert('Lütfen öğrenmek istediğiniz dili seçin.');
      return;
    }
    await persistLearnLangIfChanged();
    const { correct, total, level } = computeScore();
    if (statusEl) statusEl.textContent = `Skor: ${correct}/${total} → Seviye: ${level}`;
    // Persist
    const token = localStorage.getItem('hk_token');
    if (!token) {
      const redirect = encodeURIComponent('/placement.html');
      window.location.replace(`/?auth=1&redirect=${redirect}`);
      return;
    }
    const r = await fetch(`${backendBase}/me/placement`, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ placementLevel: level })
    });
    if (!r.ok) {
      alert('Kaydetme hatası. Lütfen tekrar deneyin.');
      return;
    }
    const url = new URL(window.location.href);
    const redirect = url.searchParams.get('redirect') || '/realtime.html';
    window.location.replace(redirect);
  } catch (e) {
    alert('Bir hata oluştu.');
  }
}

// Dil seçilince quiz görünür hale getir ve soruları yüke
if (learnLangSelect){
  learnLangSelect.addEventListener('change', async () => {
    const code = learnLangSelect.value || '';
    const quiz = document.getElementById('quiz');
    if (!code){ if (quiz) quiz.style.display = 'none'; return; }
    // Persist immediately (tercihen anında)
    try{
      const token = localStorage.getItem('hk_token');
      if (token){
        await fetch(`${backendBase}/me/preferences`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ preferredLearningLanguage: code }) });
      }
    }catch{}
    // Load pool file for selected language; fallback to en
    async function loadPool(lang){
      try{
        const r = await fetch(`/placement-pools/${lang}.json`, { cache: 'no-cache' });
        if (r.ok){ const j = await r.json(); return Array.isArray(j.questions) ? j.questions : []; }
      } catch{}
      return [];
    }
    let qs = await loadPool(code);
    if (!qs || qs.length === 0) {
      qs = await loadPool('en');
    }
    currentQuestions = qs;
    // reset adaptive state
    step = 0; usedIds = new Set(); history = []; currentLevelIdx = 2; started = false;
    // Render
    if (quiz){ quiz.innerHTML = ''; quiz.style.display = 'block'; delete quiz.dataset.qid; delete quiz.dataset.answer; }
    if (btnNext) { btnNext.style.display = 'inline-block'; try{ btnNext.textContent = 'Teste Başla'; }catch{} }
    if (btnSubmit) btnSubmit.style.display = 'none';
    statusEl && (statusEl.textContent = '');
    // If pool empty, inform user immediately
    if (!currentQuestions || currentQuestions.length === 0){
      statusEl && (statusEl.textContent = 'Bu dil için soru havuzu bulunamadı. Lütfen başka bir dil seçin.');
      if (btnNext) btnNext.style.display = 'none';
    }
  });
}

populateLearnLang();

if (btnNext){
  btnNext.addEventListener('click', () => {
    if (!started){
      // first click: render first question and switch to next mode
      started = true;
      try { btnNext.textContent = 'Sonraki Soru'; } catch {}
      renderCurrentQuestion();
      return;
    }
    const quiz = document.getElementById('quiz');
    const qid = quiz?.dataset?.qid;
    const answer = Number(quiz?.dataset?.answer ?? -1);
    if (!qid){ return; }
    const sel = document.querySelector(`input[name="${qid}"]:checked`);
    if (!sel){ alert('Lütfen bir seçenek seçin.'); return; }
    const correct = Number(sel.value) === answer;
    const currentIdxSnapshot = currentLevelIdx;
    history.push({ levelIdx: currentIdxSnapshot, correct, qid });
    usedIds.add(qid);
    // adjust level up/down
    if (correct) currentLevelIdx = Math.min(levelOrder.length-1, currentLevelIdx + 1);
    else currentLevelIdx = Math.max(0, currentLevelIdx - 1);
    step++;
    if (step >= maxSteps){
      // finish
      if (btnNext) btnNext.style.display = 'none';
      if (btnSubmit) btnSubmit.style.display = 'inline-block';
      const tmp = computeScore();
      statusEl && (statusEl.textContent = `Ön sonuç: ${tmp.level} (Doğru ${tmp.correct}/${tmp.total}). Bitirmek için tıklayın.`);
      return;
    }
    renderCurrentQuestion();
  });
}

btnSubmit && btnSubmit.addEventListener('click', submitPlacement);

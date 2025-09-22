// Use environment variable or fallback to production API
const backendBase = 'https://api.konuskonusabilirsen.com';

// Helper function for API calls with error handling
async function apiFetch(endpoint, options = {}) {
  const token = localStorage.getItem('hk_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...options.headers
  };

  try {
    const response = await fetch(`${backendBase}${endpoint}`, {
      ...options,
      headers,
      credentials: 'include' // Important for cookies
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'API request failed');
    }
    
    return response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}
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
  try {
    const me = await apiFetch('/me');
    const code = me?.user?.preferredLearningLanguage || 'tr'; // preferredLearningLanguage'dan al
    const opt = Array.from(learnLangSelect.options).find(o => o.value === code);
    if (opt) opt.selected = true; else learnLangSelect.value = 'tr';
  } catch (error) {
    console.log('Could not load user preferences:', error);
  }
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
  try {
    const code = learnLangSelect?.value || '';
    if (!code) {
      throw new Error('Lütfen hedef dili seçin');
    }

    try {
      const me = await apiFetch('/me');
      const current = me?.user?.preferredLearningLanguage || 'en'; // preferredLearningLanguage olarak kaydet

      if (current !== code) {
        // Doğrudan user'ı güncelle
        const user = await apiFetch('/me', {
          method: 'PATCH',
          body: JSON.stringify({ preferredLearningLanguage: code })
        });
      }
    } catch (error) {
      if (error.message !== 'API request failed') {
        throw error; // Only throw if it's not an auth error
      }
    }
  } catch (error) {
    console.error('Failed to save learning language preference:', error);
    throw error;
  }
}

async function submitPlacement(){
  try {
    if (btnSubmit) btnSubmit.disabled = true;
    
    try {
      await persistLearnLangIfChanged();
      const { correct, total, level } = computeScore();
      
      if (statusEl) {
        statusEl.textContent = `Skor: ${correct}/${total} → Seviye: ${level}`;
      }
      
      // Save placement result
      try {
        await apiFetch('/me/placement', {
          method: 'PATCH',
          body: JSON.stringify({ 
            level,
            score: correct,
            totalQuestions: total,
            completedAt: new Date().toISOString()
          })
        });
        
        // Redirect after successful save
        const url = new URL(window.location.href);
        const redirect = url.searchParams.get('redirect') || '/konus';
        window.location.replace(redirect);
        
      } catch (error) {
        console.error('Placement save error:', error);
        const errorMessage = error.message || 'Beklenmeyen bir hata oluştu';
        
        if (error.message.includes('401') || error.message.includes('token')) {
          // Handle unauthorized - redirect to login
          const redirect = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.replace(`/?auth=1&redirect=${redirect}`);
          return;
        }
        
        // Show error but don't block user from continuing
        alert(`Kaydetme uyarısı: ${errorMessage}. Devam edebilirsiniz.`);
        
        // Still redirect even if save fails
        const url = new URL(window.location.href);
        const redirect = url.searchParams.get('redirect') || '/konus';
        window.location.replace(redirect);
      }
      
    } catch (error) {
      console.error('Error in placement submission:', error);
      alert(`Bir hata oluştu: ${error.message || 'Lütfen daha sonra tekrar deneyin.'}`);
      
      // Re-enable submit button on error
      if (btnSubmit) btnSubmit.disabled = false;
    }
  } catch (e) {
    console.error('Unexpected error in submitPlacement:', e);
    alert('Beklenmeyen bir hata oluştu. Lütfen sayfayı yenileyip tekrar deneyin.');
    if (btnSubmit) btnSubmit.disabled = false;
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
        const me = await apiFetch('/me');
        const current = me?.user?.preferredLearningLanguage || 'en';

        if (current !== code) {
          await apiFetch('/me', {
            method: 'PATCH',
            body: JSON.stringify({ preferredLearningLanguage: code })
          });
        }
      }
    }catch{}
    // Load pool file for selected language; fallback to en
    async function loadPool(lang){
      try{
        const r = await fetch(`/placement-pools/${lang}.json`, { 
      cache: 'no-cache',
      credentials: 'include' // Include cookies for authentication if needed
    });
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

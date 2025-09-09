const backendBase = location.origin;

function $(s){ return document.querySelector(s); }

function getToken(){ return localStorage.getItem('hk_token'); }

function fillLangSelect(el, def){
  if (!el) return;
  const langs = [
    { code: 'tr', name: 'Türkçe' }, { code: 'en', name: 'İngilizce' }, { code: 'de', name: 'Almanca' },
    { code: 'fr', name: 'Fransızca' }, { code: 'es', name: 'İspanyolca' }, { code: 'it', name: 'İtalyanca' },
    { code: 'pt', name: 'Portekizce' }, { code: 'ru', name: 'Rusça' }, { code: 'ar', name: 'Arapça' },
    { code: 'fa', name: 'Farsça' }, { code: 'hi', name: 'Hintçe' }, { code: 'zh-CN', name: 'Çince (Basit)' },
    { code: 'ja', name: 'Japonca' }, { code: 'ko', name: 'Korece' }
  ];
  el.innerHTML = '';
  langs.forEach(l => {
    const opt = document.createElement('option'); opt.value = l.code; opt.textContent = `${l.name} (${l.code})`;
    if (l.code === def) opt.selected = true;
    el.appendChild(opt);
  });
}

async function loadMe(){
  const token = getToken();
  const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` }});
  if (!r.ok) throw new Error('me_error');
  return r.json();
}

async function loadUsage(){
  const token = getToken();
  const r = await fetch(`${backendBase}/usage`, { headers: { Authorization: `Bearer ${token}` }});
  if (!r.ok) return null;
  return r.json();
}

async function init(){
  try {
    const me = await loadMe();
    const badgePlan = $('#accBadgePlan');
    const badgeLevel = $('#accBadgeLevel');
    const emailEl = $('#accEmail');
    const verEl = $('#accVerified');
    if (badgePlan) badgePlan.textContent = `Plan: ${me.plan || 'free'}`;
    if (badgeLevel) badgeLevel.textContent = `Seviye: ${me.placementLevel || '-'}`;
    if (emailEl) emailEl.textContent = me.email || '-';
    if (verEl) verEl.textContent = `Doğrulama: ${me.emailVerified ? 'Doğrulandı' : 'Bekliyor'}`;
    const planText = document.getElementById('planText'); if (planText) planText.textContent = me.plan || 'free';
    const levelText = document.getElementById('levelText'); if (levelText) levelText.textContent = me.placementLevel || '-';

    // Preferences
    fillLangSelect($('#accLearnLang'), me.preferredLearningLanguage || 'tr');
    fillLangSelect($('#accNativeLang'), me.preferredNativeLanguage || 'tr');
    const voice = $('#accVoice'); if (voice) voice.value = me.preferredVoice || '';
    const corr = $('#accCorrection'); if (corr) corr.value = me.preferredCorrectionMode || 'gentle';

    const usage = await loadUsage();
    if (usage){
      const d = $('#accUsageDaily'); const m = $('#accUsageMonthly');
      if (d) d.textContent = `Günlük: ${(usage.usedDaily||0).toFixed(1)} / ${usage.limits?.daily ?? '-' } dk`;
      if (m) m.textContent = `Aylık: ${(usage.usedMonthly||0).toFixed(1)} / ${usage.limits?.monthly ?? '-' } dk`;
    }

    const btnSave = $('#accSave');
    if (btnSave){
      btnSave.addEventListener('click', async () => {
        const preferredLearningLanguage = $('#accLearnLang')?.value || 'tr';
        const preferredNativeLanguage = $('#accNativeLang')?.value || 'tr';
        const preferredVoice = $('#accVoice')?.value?.trim() || null;
        const preferredCorrectionMode = $('#accCorrection')?.value || 'gentle';
        const msg = $('#accMsg'); if (msg) msg.textContent = 'Kaydediliyor...';
        try{
          const rr = await fetch(`${backendBase}/me/preferences`, {
            method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ preferredLearningLanguage, preferredNativeLanguage, preferredVoice, preferredCorrectionMode })
          });
          const jj = await rr.json();
          if (!rr.ok){ if (msg) msg.textContent = jj?.error || 'Hata'; return; }
          if (msg) msg.textContent = 'Kaydedildi';
        } catch (e){ if (msg) msg.textContent = 'Bağlantı hatası'; }
      });
    }

    // Gamification summary
    try{
      const gr = await fetch(`${backendBase}/gamification/summary`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (gr.ok){
        const g = await gr.json();
        const streakBadge = $('#streakBadge');
        const goalBadge = $('#goalBadge');
        const goalProgress = $('#goalProgress');
        const goalText = $('#goalText');
        const goalInput = $('#goalInput');
        if (streakBadge) streakBadge.textContent = `Seri: ${g?.streak?.count || 0} gün`;
        const daily = Number(g?.goal?.dailyMinutes || 10);
        const used = Number(g?.goal?.usedDaily || 0);
        const pct = Math.max(0, Math.min(100, Math.round((used / Math.max(1,daily)) * 100)));
        if (goalBadge) goalBadge.textContent = `Günlük Hedef: ${daily} dk`;
        if (goalProgress) goalProgress.style.width = `${pct}%`;
        if (goalText) goalText.textContent = `${used.toFixed(1)}/${daily} dk`;
        if (goalInput) goalInput.value = String(daily);
        // Achievements grid
        const achGrid = $('#achGrid');
        if (achGrid){
          const unlocked = new Set((g?.achievements||[]).map(a => a.key));
          const defs = [
            { key:'streak_3', label:'3 Gün' },
            { key:'streak_7', label:'7 Gün' },
            { key:'streak_30', label:'30 Gün' },
            { key:'daily_goal_met', label:'Günlük Hedef' }
          ];
          achGrid.innerHTML = '';
          defs.forEach(def => {
            const box = document.createElement('div');
            const on = unlocked.has(def.key);
            box.style.padding = '10px';
            box.style.border = '1px solid #1b2442';
            box.style.borderRadius = '10px';
            box.style.background = on ? 'linear-gradient(135deg, rgba(124,58,237,.25), rgba(0,209,255,.18))' : '#0b1022';
            box.style.color = on ? '#e5e7eb' : '#8a93a8';
            box.style.textAlign = 'center';
            box.style.fontSize = '12px';
            box.textContent = def.label;
            achGrid.appendChild(box);
          });
        }
        // Save daily goal
        const goalSave = $('#goalSave');
        if (goalSave && goalInput){
          goalSave.addEventListener('click', async () => {
            const v = Math.max(1, Math.min(300, Number(goalInput.value || 10)));
            const msg = $('#goalMsg'); if (msg) msg.textContent = 'Kaydediliyor...';
            try{
              const rr = await fetch(`${backendBase}/gamification/goal`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ dailyMinutes: v }) });
              const jj = await rr.json();
              if (!rr.ok){ if (msg) msg.textContent = jj?.error || 'Hata'; return; }
              if (goalBadge) goalBadge.textContent = `Günlük Hedef: ${v} dk`;
              if (goalText) goalText.textContent = `${used.toFixed(1)}/${v} dk`;
              if (goalProgress) goalProgress.style.width = `${Math.max(0, Math.min(100, Math.round((used/Math.max(1,v))*100)))}%`;
              if (msg) msg.textContent = 'Kaydedildi';
            }catch(e){ const msg=$('#goalMsg'); if (msg) msg.textContent = 'Bağlantı hatası'; }
          });
        }
      }
    } catch {}
  } catch (e) {
    alert('Hesap verileri yüklenemedi.');
  }
}

init();

// Economy plan page logic: Whisper STT -> Realtime (text -> audio)
console.log('[economy] script loaded v4');
// This file intentionally does NOT modify the existing realtime app logic.

const $ = (s) => document.querySelector(s);
const backendBase = (window.__BACKEND_BASE__ && window.__BACKEND_BASE__.trim()) || window.location.origin;

const statusConn = $('#statusConn');
const statusPlan = $('#statusPlan');
const pillMinutes = $('#pillMinutes');
const btnMain = $('#btnMain');
const btnReplay = $('#btnReplay');
const recDot = $('#recDot');
const transcriptEl = $('#transcript');
const remoteAudio = $('#remoteAudio');
// Advanced controls (same ids as realtime)
const voiceSelect = document.getElementById('voiceSelect');
const scenarioSelect = document.getElementById('scenarioSelect');
const learnLangSelect = document.getElementById('learnLangSelect');
const nativeLangSelect = document.getElementById('nativeLangSelect');
const corrSelect = document.getElementById('corrSelect');

let ws = null;
let wsAudioChunks = [];
let wsPlaybackCtx = null;
let wsPlaybackSource = null;
let lastResponseBuffer = null;
// Streaming playback state
let wsPlayhead = 0;          // scheduled playback time (AudioContext seconds)
let wsGainNode = null;       // shared gain node for streaming
let wsScheduledNodes = [];   // list of scheduled BufferSource nodes for current bot turn
const STREAM_PLAYBACK = true; // enable low-latency streaming playback
// Streaming mic state (STT kaldırıldı; Realtime'a PCM akışı)
let audioCtx = null;
let micStream = null;
let micSource = null;
let micProcessor = null;
let micStreaming = false;   // currently streaming within a turn
let vadSilenceMs = 0;
let bytesSinceStart = 0;
let isBotSpeaking = false;
const MAX_TURN_MS = 4500;   // hard limit for a single user turn before forcing commit
let turnElapsedMs = 0;
function setConn(open){ try{ statusConn.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`; }catch{} }
function setPlan(text){ try{ statusPlan.textContent = `Plan: ${text||'-'}`; }catch{} }
function setMinutes(used, limit){ try{ pillMinutes.textContent = `Günlük: ${Number(used||0).toFixed(1)}/${limit} dk`; }catch{} }
function setRec(on){ try{ recDot.classList.toggle('on', !!on); }catch{} }

// Simple modal to prompt upgrade when quota is over
function showQuotaModal(usage){
  try{
    let modal = document.getElementById('quotaModal');
    if (!modal){
      modal = document.createElement('div');
      modal.id = 'quotaModal';
      modal.style.cssText = `position:fixed; inset:0; background:rgba(0,0,0,.5); backdrop-filter: blur(6px); z-index:50; display:flex; align-items:center; justify-content:center;`;
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'max-width:520px; width:90%; margin:20px; padding:28px; text-align:center;';
      const h3 = document.createElement('h3'); h3.textContent = 'Kota Bitti'; h3.style.margin = '0 0 10px';
      const msg = document.createElement('div'); msg.className = 'subtle'; msg.style.marginBottom = '14px';
      msg.id = 'quotaMsg';
      const row = document.createElement('div'); row.className = 'row'; row.style.gap = '10px'; row.style.justifyContent = 'center';
      const btnPlans = document.createElement('a'); btnPlans.className = 'btn btn-primary'; btnPlans.textContent = 'Planları Göster'; btnPlans.style.minWidth = '140px'; btnPlans.href = '/#pricing';
      const btnAccount = document.createElement('a'); btnAccount.className = 'btn btn-secondary'; btnAccount.textContent = 'Hesabım'; btnAccount.style.minWidth = '120px'; btnAccount.href = '/account.html';
      const btnClose = document.createElement('button'); btnClose.className = 'btn'; btnClose.textContent = 'Kapat'; btnClose.style.minWidth = '100px';
      btnClose.addEventListener('click', () => { modal.style.display = 'none'; });
      row.appendChild(btnPlans); row.appendChild(btnAccount); row.appendChild(btnClose);
      card.appendChild(h3); card.appendChild(msg); card.appendChild(row); modal.appendChild(card);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
      document.body.appendChild(modal);
    }
    const m = document.getElementById('quotaMsg');
    if (m){
      const used = Number(usage?.usedDaily||0).toFixed(1);
      const lim = usage?.limits?.daily ?? '-';
      m.textContent = `Günlük kullanımınız doldu (${used}/${lim} dk). Devam etmek için planları inceleyin.`;
    }
    modal.style.display = 'flex';
  }catch{}
}

let micCapturing = false;

function updateMainButton(){
  try {
    if (!btnMain) return;
    btnMain.textContent = micCapturing ? 'Durdur' : 'Başla';
    btnMain.disabled = false;
  } catch {}
}

function wsEnsurePlaybackCtx(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!wsPlaybackCtx || (wsPlaybackCtx && wsPlaybackCtx.state === 'closed')){
    wsPlaybackCtx = new AC({ sampleRate: 24000 });
  }
  if (wsPlaybackCtx.state === 'suspended') wsPlaybackCtx.resume();
}

function wsEnsureStreamGraph(){
  wsEnsurePlaybackCtx();
  if (!wsGainNode){
    try{
      wsGainNode = wsPlaybackCtx.createGain();
      wsGainNode.gain.value = 1.25;
      wsGainNode.connect(wsPlaybackCtx.destination);
    }catch{}
  }
}

function wsStopScheduled(){
  try{
    wsScheduledNodes.forEach(src => { try { src.stop(); } catch {} });
  }catch{}
  wsScheduledNodes = [];
}

function wsScheduleChunkPcm(arrayBuffer){
  try{
    if (!STREAM_PLAYBACK) return;
    wsEnsureStreamGraph();
    const pcm16 = new Int16Array(arrayBuffer);
    const len = pcm16.length;
    if (len === 0) return;
    const audioBuffer = wsPlaybackCtx.createBuffer(1, len, 24000);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i=0;i<len;i++){ ch0[i] = Math.max(-1, Math.min(1, pcm16[i] / 32768)); }
    const src = wsPlaybackCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(wsGainNode);
    const now = wsPlaybackCtx.currentTime;
    const startAt = Math.max(wsPlayhead || (now + 0.05), now + 0.02);
    try { src.start(startAt); } catch {}
    wsScheduledNodes.push(src);
    wsPlayhead = startAt + (len / 24000);
  }catch(e){ try{ console.log('[economy] schedule error', e?.message||e); }catch{} }
}

function wsPlayPcm(arrayBuffer){
  try{
    wsEnsurePlaybackCtx();
    const pcm16 = new Int16Array(arrayBuffer);
    const len = pcm16.length;
    if (len === 0) return;
    const padSamples = Math.floor(24000 * 0.12);
    const totalLen = len + padSamples;
    const audioBuffer = wsPlaybackCtx.createBuffer(1, totalLen, 24000);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i=0;i<len;i++){ ch0[i] = Math.max(-1, Math.min(1, pcm16[i] / 32768)); }
    for (let i=len;i<totalLen;i++){ ch0[i] = 0; }
    if (wsPlaybackSource) { try { wsPlaybackSource.stop(); } catch {} }
    const src = wsPlaybackCtx.createBufferSource();
    src.buffer = audioBuffer;
    const gain = wsPlaybackCtx.createGain();
    gain.gain.value = 1.4;
    src.connect(gain);
    gain.connect(wsPlaybackCtx.destination);
    wsPlaybackSource = src;
    src.start();
    // Oynatma bittiğinde otomatik yeni tura hazır ol
    try {
      src.onended = () => {
        try {
          isBotSpeaking = false;
          // VAD, kullanıcı konuştuğunda yeni turu başlatacak (capture açıkken)
        } catch {}
      };
    } catch {}
  }catch(e){ console.log('[economy] play error', e?.message||e); }
}

async function updateMePills(){
  try{
    const token = localStorage.getItem('hk_token');
    if (!token) return;
    const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const me = await r.json();
    const plan = me?.user?.plan || me?.plan || 'free';
    setPlan(plan);
    const usage = me?.user?.usage || me?.usage;
    if (usage){ setMinutes(usage.dailyUsed||0, usage.dailyLimit ?? '-'); }
    // Prefill selects from user preferences if present
    try{
      if (learnLangSelect && me.user?.preferredLearningLanguage){ learnLangSelect.value = me.user.preferredLearningLanguage; }
      if (nativeLangSelect && me.user?.preferredNativeLanguage){ nativeLangSelect.value = me.user.preferredNativeLanguage; }
      if (voiceSelect && me.user?.preferredVoice){ voiceSelect.value = me.user.preferredVoice; }
      if (corrSelect && me.user?.preferredCorrectionMode){ corrSelect.value = me.user.preferredCorrectionMode; }
    }catch{}
  }catch{}
}

// Populate language selects with curated list (copy from realtime)
function populateLanguageSelects(){
  const langs = [
    { code: 'tr', name: 'Türkçe' },
    { code: 'en', name: 'İngilizce' },
    { code: 'de', name: 'Almanca' },
    { code: 'fr', name: 'Fransızca' },
    { code: 'es', name: 'İspanyolca' },
    { code: 'it', name: 'İtalyanca' },
    { code: 'pt', name: 'Portekizce' },
    { code: 'pt-BR', name: 'Portekizce (Brezilya)' },
    { code: 'ru', name: 'Rusça' },
    { code: 'ar', name: 'Arapça' },
    { code: 'fa', name: 'Farsça' },
    { code: 'hi', name: 'Hintçe' },
    { code: 'bn', name: 'Bengalce' },
    { code: 'ur', name: 'Urduca' },
    { code: 'id', name: 'Endonezce' },
    { code: 'ms', name: 'Malayca' },
    { code: 'vi', name: 'Vietnamca' },
    { code: 'th', name: 'Tayca' },
    { code: 'zh-CN', name: 'Çince (Basitleştirilmiş)' },
    { code: 'zh-TW', name: 'Çince (Geleneksel)' },
    { code: 'ja', name: 'Japonca' },
    { code: 'ko', name: 'Korece' },
    { code: 'nl', name: 'Felemenkçe' },
    { code: 'sv', name: 'İsveççe' },
    { code: 'no', name: 'Norveççe' },
    { code: 'da', name: 'Danca' },
    { code: 'fi', name: 'Fince' },
    { code: 'pl', name: 'Lehçe' },
    { code: 'cs', name: 'Çekçe' },
    { code: 'sk', name: 'Slovakça' },
    { code: 'ro', name: 'Romence' },
    { code: 'el', name: 'Yunanca' },
    { code: 'uk', name: 'Ukraynaca' },
    { code: 'he', name: 'İbranice' },
    { code: 'hu', name: 'Macarca' },
    { code: 'bg', name: 'Bulgarca' },
    { code: 'sr', name: 'Sırpça' },
    { code: 'hr', name: 'Hırvatça' },
    { code: 'sl', name: 'Slovence' },
    { code: 'lt', name: 'Litvanca' },
    { code: 'lv', name: 'Letonca' },
    { code: 'et', name: 'Estonca' },
    { code: 'fil', name: 'Filipince' },
  ];
  function fill(selectEl, defaultCode){
    if (!selectEl) return;
    // Avoid duplicate filling
    if (selectEl.options && selectEl.options.length > 5) return;
    selectEl.innerHTML = '';
    langs.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code; opt.textContent = `${l.name} (${l.code})`;
      if (l.code === defaultCode) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }
  fill(learnLangSelect, 'en');
  fill(nativeLangSelect, 'tr');
}

async function populateScenarios(){
  try{
    if (!scenarioSelect) return;
    const r = await fetch(`${backendBase}/scenarios`);
    if (!r.ok) return;
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    while (scenarioSelect.options.length > 1) scenarioSelect.remove(1);
    items.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.title} ${s.level ? '('+s.level+')' : ''}`;
      scenarioSelect.appendChild(opt);
    });
  } catch {}
}

function sendPrefsToWs(){
  try{
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const voice = voiceSelect && voiceSelect.value ? voiceSelect.value : 'alloy';
    const learnLang = learnLangSelect && learnLangSelect.value ? learnLangSelect.value : 'en';
    const nativeLang = nativeLangSelect && nativeLangSelect.value ? nativeLangSelect.value : 'tr';
    const correction = corrSelect && corrSelect.value ? corrSelect.value : 'gentle';
    const scenarioId = scenarioSelect && scenarioSelect.value ? scenarioSelect.value : '';
    ws.send(JSON.stringify({ type:'set_prefs', prefs:{ voice, learnLang, nativeLang, correction, scenarioId } }));
  } catch {}
}

async function persistPrefs(partial){
  try{
    const token = localStorage.getItem('hk_token');
    if (token){
      await fetch(`${backendBase}/me/preferences`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(partial) });
    }
  }catch{}
}

async function connect(autostart = false){
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (autostart && !micCapturing) startCapture();
    return;
  }
  if (btnMain) btnMain.disabled = true;
  try{
    const token = localStorage.getItem('hk_token');
    if (!token){ window.location.replace(`/?auth=1&redirect=${encodeURIComponent('/ekonomi')}`); return; }

    // Start session with economy plan
    const r = await fetch(`${backendBase}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: 'economy' })
    });
    if (!r.ok){
      if (r.status === 401){ window.location.replace(`/?auth=1&redirect=${encodeURIComponent('/ekonomi')}`); return; }
      const j = await r.json().catch(()=>({}));
      if (r.status === 403 && j?.error === 'placement_required'){
        const redirect = encodeURIComponent('/ekonomi');
        window.location.replace(`/placement.html?redirect=${redirect}`);
        return;
      }
      if (r.status === 403 && j?.error === 'limit_reached'){
        // Show quota modal and disable main button
        try{
          const usage = { usedDaily: j.minutesUsedDaily ?? j.usage?.dailyUsed, usedMonthly: j.minutesUsedMonthly ?? j.usage?.monthlyUsed, limits: j.limits };
          if (typeof usage.usedDaily === 'number' && usage.limits?.daily){ setMinutes(usage.usedDaily||0, usage.limits.daily ?? '-'); }
          showQuotaModal(usage);
        }catch{}
        if (btnMain) btnMain.disabled = true; updateMainButton();
        return;
      }
      alert(j?.error || `Bağlantı başlatılamadı (${r.status})`);
      if (btnMain) btnMain.disabled = false; updateMainButton(); return;
    }
    const s = await r.json();
    const url = s.wsUrl.startsWith('ws') ? s.wsUrl : `${backendBase.replace('http','ws')}${s.wsUrl}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    try { window._ekWs = ws; console.log('[economy] WS connecting to', url); } catch {}
    ws.onopen = () => {
      setConn(true);
      updateMePills();
      // Realtime ile aynı: prefs'i WS'e aktar, voice'i session.update ile bildir
      try { sendPrefsToWs(); } catch {}
      try {
        const voice = voiceSelect && voiceSelect.value ? voiceSelect.value : 'alloy';
        ws.send(JSON.stringify({ type:'session.update', session:{ voice } }));
      } catch {}
      if (autostart) {
        setTimeout(() => { try { if (!micCapturing) startCapture(); } catch {} }, 150);
      } else {
        updateMainButton();
      }
    };
    ws.onclose = () => {
      setConn(false);
      try { stopCapture(true); } catch {}
      micCapturing = false;
      setRec(false);
      updateMainButton();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string'){
        try{
          const obj = JSON.parse(ev.data);
          if (obj.type === 'usage_update' && obj.usage){
            setMinutes(obj.usage.usedDaily||0, obj.usage.limits?.daily ?? '-');
          }
          if (obj.type === 'limit_reached'){
            if (btnMain) btnMain.disabled = true;
            try{ showQuotaModal(obj.usage); }catch{}
          }
          if (obj.type === 'bot_speaking'){
            wsAudioChunks = [];
            isBotSpeaking = true;
            // Bot konuşmaya başlarsa kullanıcı akışını sonlandır
            try { if (micStreaming && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {}
            micStreaming = false;
            // Prepare streaming scheduler
            try { wsEnsureStreamGraph(); wsStopScheduled(); wsPlayhead = (wsPlaybackCtx?.currentTime || 0) + 0.05; } catch {}
          }
          if (obj.type === 'debug'){
            try { console.log('[economy][debug]', obj); } catch {}
          }
          if (obj.type === 'error'){
            try { console.error('[economy][ws error]', obj.error || obj); } catch {}
            try { alert(`Sunucu hata döndürdü: ${obj?.error?.message || obj?.error?.code || 'unknown'}`); } catch {}
          }
          if (obj.type === 'transcript'){
            try {
              const text = String(obj.text||'');
              const lines = (transcriptEl.textContent || '').split('\n');
              const lastIdx = lines.length - 1;
              if (!obj.final){
                if (lastIdx >= 0 && lines[lastIdx].startsWith('[BOT')){
                  lines[lastIdx] = `[BOT•] ${text}`;
                } else {
                  lines.push(`[BOT•] ${text}`);
                }
              } else {
                if (lastIdx >= 0 && lines[lastIdx].startsWith('[BOT•] ')){
                  lines[lastIdx] = `[BOT] ${text}`;
                } else {
                  lines.push(`[BOT] ${text}`);
                }
              }
              transcriptEl.textContent = lines.filter(l => l !== '').join('\n');
            } catch {}
          }
          if (obj.type === 'audio_end'){
            const total = wsAudioChunks.reduce((s,a)=> s + a.byteLength, 0);
            const merged = new Uint8Array(total);
            let off = 0; for (const c of wsAudioChunks){ merged.set(new Uint8Array(c), off); off += c.byteLength; }
            lastResponseBuffer = merged.buffer;
            try { console.debug('[economy] audio_end totalBytes=', total); } catch {}
            if (btnReplay) btnReplay.disabled = false;
            if (total <= 0){
              // Sessiz yanıt; sadece bot konuşma durumunu sıfırla
              isBotSpeaking = false;
            } else if (STREAM_PLAYBACK) {
              // Streaming modunda: planlanan son chunk zamanına göre bitişi işaretle
              try {
                const now = wsPlaybackCtx ? wsPlaybackCtx.currentTime : 0;
                const remainingMs = Math.max(0, (wsPlayhead - now) * 1000);
                setTimeout(() => {
                  try { isBotSpeaking = false; } catch {}
                }, Math.min(2500, remainingMs + 80));
              } catch {}
            } else {
              // Fallback: tüm yanıtı tek parça olarak çal
              wsPlayPcm(lastResponseBuffer);
            }
            wsAudioChunks = [];
          }
        }catch{}
      } else {
        // binary PCM
        try { if (STREAM_PLAYBACK) wsScheduleChunkPcm(ev.data); } catch {}
        wsAudioChunks.push(ev.data);
        }
    };
  }catch(e){
    alert('Bağlantı hatası');
    if (btnMain) btnMain.disabled = false;
  }
}

// Wire UI events -> prefs
try{
  if (voiceSelect){
    voiceSelect.addEventListener('change', async () => {
      try{ if (ws && ws.readyState === WebSocket.OPEN){ ws.send(JSON.stringify({ type:'session.update', session:{ voice: voiceSelect.value||'alloy' } })); } }catch{}
      try{ sendPrefsToWs(); }catch{}
      try{ await persistPrefs({ preferredVoice: voiceSelect.value||'alloy' }); }catch{}
    });
  }
  if (learnLangSelect){ learnLangSelect.addEventListener('change', async () => { try{ sendPrefsToWs(); }catch{} try{ await persistPrefs({ preferredLearningLanguage: learnLangSelect.value }); }catch{} }); }
  if (nativeLangSelect){ nativeLangSelect.addEventListener('change', async () => { try{ sendPrefsToWs(); }catch{} try{ await persistPrefs({ preferredNativeLanguage: nativeLangSelect.value }); }catch{} }); }
  if (corrSelect){ corrSelect.addEventListener('change', async () => { try{ sendPrefsToWs(); }catch{} try{ await persistPrefs({ preferredCorrectionMode: corrSelect.value }); }catch{} }); }
  if (scenarioSelect){ scenarioSelect.addEventListener('change', () => { try{ sendPrefsToWs(); }catch{} }); }
}catch{}

function disconnect(){
  try{ if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000,'bye'); }catch{}
  ws = null;
  setConn(false);
  try { stopCapture(true); } catch {}
  micCapturing = false;
  setRec(false);
  updateMainButton();
}

// ----- Realtime Mic Streaming (no STT) -----
function floatTo16BitPCM(input){
  const out = new Int16Array(input.length);
  for (let i=0;i<input.length;i++){
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out.buffer;
}

async function startCapture(){
  if (!ws || ws.readyState !== WebSocket.OPEN) { await connect(true); return; }
  if (micCapturing) return;
  try{
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true } });
  } catch(e){ alert('Mikrofon izni/erişimi yok'); return; }
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  } catch(e){ try{ micStream.getTracks().forEach(t=>t.stop()); }catch{} alert('AudioContext açılamadı'); return; }
  micSource = audioCtx.createMediaStreamSource(micStream);
  micProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
  const speakThreshold = 0.02;
  micProcessor.onaudioprocess = (ev) => {
    try{
      const ch = ev.inputBuffer.getChannelData(0);
      let sum = 0; for (let i=0;i<ch.length;i++){ const v = ch[i]; sum += v*v; }
      const rms = Math.sqrt(sum / ch.length);
      const ms = (ch.length / (audioCtx.sampleRate || 24000)) * 1000;

      if (isBotSpeaking) {
        // Bot konuşurken kullanıcı akışını başlatma / devam ettirme
        vadSilenceMs = 0;
        if (micStreaming) { try { ws.send(JSON.stringify({ type: 'audio_stop' })); } catch{} micStreaming = false; setRec(false); }
        return;
      }

      if (!micStreaming && rms > speakThreshold) {
        // Yeni tur başlat
        try { ws.send(JSON.stringify({ type: 'audio_start', format: 'pcm16', sampleRate: 24000, channels: 1 })); } catch {}
        micStreaming = true; bytesSinceStart = 0; vadSilenceMs = 0; turnElapsedMs = 0; setRec(true);
      }

      if (micStreaming) {
        const buf = floatTo16BitPCM(ch);
        try { ws.send(buf); } catch {}
        bytesSinceStart += buf.byteLength;
        turnElapsedMs += ms;
        if (rms > speakThreshold) {
          vadSilenceMs = 0;
        } else {
          vadSilenceMs += ms;
          if (vadSilenceMs >= 300) {
            try { ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {}
            micStreaming = false; setRec(false); vadSilenceMs = 0; bytesSinceStart = 0; turnElapsedMs = 0;
          }
        }

        // Force-stop fallback: if user keeps streaming (noise) and silence never triggers
        if (turnElapsedMs >= MAX_TURN_MS) {
          try { ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {}
          micStreaming = false; setRec(false); vadSilenceMs = 0; bytesSinceStart = 0; turnElapsedMs = 0;
        }
      }
    }catch{}
  };
  // Başlar başlamaz input turunu aç (kullanıcıyı bekletme)
  try { ws.send(JSON.stringify({ type: 'audio_start', format: 'pcm16', sampleRate: 24000, channels: 1 })); } catch {}
  micStreaming = true; bytesSinceStart = 0; vadSilenceMs = 0; turnElapsedMs = 0; setRec(true);
  micSource.connect(micProcessor);
  micProcessor.connect(audioCtx.destination);
  micCapturing = true; updateMainButton();
}

function stopCapture(silent){
  try { if (micStreaming && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stop' })); } catch{}
  micStreaming = false; setRec(false);
  try { micProcessor && micProcessor.disconnect(); } catch {}
  try { micSource && micSource.disconnect(); } catch {}
  try { micStream && micStream.getTracks().forEach(t=>t.stop()); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  micProcessor = null; micSource = null; micStream = null; audioCtx = null;
  micCapturing = false; if (!silent) updateMainButton();
}

if (btnMain) btnMain.addEventListener('click', async () => {
  try {
    if (!ws || (ws.readyState !== WebSocket.OPEN)) {
      await connect(true); // bağlan ve kaydı başlat
    } else {
      if (!micCapturing) { await startCapture(); } else { stopCapture(); }
    }
  } catch {}
});
if (btnReplay) btnReplay.addEventListener('click', () => { try{ if (lastResponseBuffer) wsPlayPcm(lastResponseBuffer); }catch{} });

// Prefetch pills and populate controls on load
try { populateLanguageSelects(); } catch {}
try { populateScenarios(); } catch {}
updateMePills().catch(()=>{});

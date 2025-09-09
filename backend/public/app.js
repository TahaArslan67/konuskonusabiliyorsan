const $ = (s) => document.querySelector(s);
const logEl = $('#logs');
const backendBase = (typeof window !== 'undefined' && window.__BACKEND_BASE__) ? window.__BACKEND_BASE__ : location.origin; // configurable backend base
const statusConnEl = $('#statusConn');
const statusMicEl = $('#statusMic');
$('#backend') && ($('#backend').textContent = backendBase);

let pc, dc, localStream;
let ws;
let wsMicStream;
let wsAudioCtx, wsProcessor, wsSource; // mic capture
let wsPlaybackCtx; // playback for server PCM
let wsPlaybackSource = null; // current playback source for interruption
let wsBotSpeaking = false; // whether bot is currently speaking
let wsBargeInPending = false; // debounce for barge-in
let wsBargeInTimer = null; // timer handle
let wsBargeInConfirmed = false; // set true after debounce passes
let wsAudioChunks = [];
let lastResponseBuffer = null;
let wsMicWasOnBeforeBot = false;
let wsVadSpeaking = false;
let wsVadSilenceMs = 0;
let wsBytesSinceStart = 0;
let wsMicStreaming = false; // whether we've sent audio_start and streaming chunks
let wsNoStartUntil = 0; // cooldown timestamp (ms since epoch) preventing immediate restarts
let wsStartRequested = false; // if user pressed big start button
let micToggleOn = false; // state of mic toggle button
let wsForceSilence = false; // when true, ignore/stop any bot audio
let wsAutoEndTimer = null; // inactivity-based synthetic audio_end timer

// ---- Bot visualization (canvas + analyser) ----
let vizCanvas = null, vizCtx = null, vizAnalyser = null, vizTimeData = null, vizAnimId = null;
function vizInit(){
  try{
    vizCanvas = document.getElementById('botViz');
    if (!vizCanvas) return;
    const parent = vizCanvas.parentElement;
    const rect = parent.getBoundingClientRect();
    vizCanvas.width = rect.width; vizCanvas.height = rect.height;
    vizCtx = vizCanvas.getContext('2d');
    window.addEventListener('resize', () => {
      const r = parent.getBoundingClientRect();
      vizCanvas.width = r.width; vizCanvas.height = r.height;
    });
  } catch {}

function waitWsOpen(timeoutMs = 4000){
  return new Promise((resolve) => {
    try{
      if (ws && ws.readyState === WebSocket.OPEN) return resolve(true);
      const t = setTimeout(() => resolve(false), timeoutMs);
      const onOpen = () => { try { clearTimeout(t); } catch {}; try { ws && ws.removeEventListener('open', onOpen); } catch {}; resolve(true); };
      ws && ws.addEventListener('open', onOpen);
    } catch { resolve(false); }
  });
}
}
function vizStart(){
  if (!vizCanvas || !vizCtx) vizInit();
  if (vizAnimId) return;
  const draw = () => {
    try{
      const w = vizCanvas.width, h = vizCanvas.height;
      vizCtx.clearRect(0,0,w,h);
      // background glow
      vizCtx.fillStyle = 'rgba(14,20,48,0.3)';
      vizCtx.fillRect(0,0,w,h);
      if (vizAnalyser && vizTimeData){
        // Time-domain waveform centered (vocal cords style): mirrored path around center line
        vizAnalyser.getByteTimeDomainData(vizTimeData);
        const centerY = h * 0.55;
        const scale = h * 0.28; // amplitude scale
        // Smooth top path
        vizCtx.lineWidth = 2.5;
        vizCtx.shadowBlur = 12;
        vizCtx.shadowColor = 'rgba(124,58,237,0.35)';
        const gradTop = vizCtx.createLinearGradient(0, 0, w, 0);
        gradTop.addColorStop(0, 'rgba(0,209,255,0.95)');
        gradTop.addColorStop(1, 'rgba(124,58,237,0.95)');
        vizCtx.strokeStyle = gradTop;
        vizCtx.beginPath();
        const points = 160; // resample for smooth drawing
        for (let i = 0; i < points; i++){
          const idx = Math.floor((i / (points-1)) * (vizTimeData.length - 1));
          const v = (vizTimeData[idx] - 128) / 128; // -1..1
          const x = (i / (points-1)) * w;
          const y = centerY - v * scale;
          if (i === 0) vizCtx.moveTo(x, y); else vizCtx.lineTo(x, y);
        }
        vizCtx.stroke();
        // Bottom mirrored path
        vizCtx.lineWidth = 2.5;
        vizCtx.shadowBlur = 10;
        vizCtx.shadowColor = 'rgba(0,209,255,0.28)';
        const gradBottom = vizCtx.createLinearGradient(0, 0, w, 0);
        gradBottom.addColorStop(0, 'rgba(124,58,237,0.85)');
        gradBottom.addColorStop(1, 'rgba(0,209,255,0.85)');
        vizCtx.strokeStyle = gradBottom;
        vizCtx.beginPath();
        for (let i = 0; i < points; i++){
          const idx = Math.floor((i / (points-1)) * (vizTimeData.length - 1));
          const v = (vizTimeData[idx] - 128) / 128; // -1..1
          const x = (i / (points-1)) * w;
          const y = centerY + v * scale * 0.9; // slight asymmetry for organic feel
          if (i === 0) vizCtx.moveTo(x, y); else vizCtx.lineTo(x, y);
        }
        vizCtx.stroke();
        // Center glow line
        vizCtx.lineWidth = 1;
        vizCtx.strokeStyle = 'rgba(255,255,255,0.08)';
        vizCtx.beginPath(); vizCtx.moveTo(0, centerY); vizCtx.lineTo(w, centerY); vizCtx.stroke();
      } else {
        // fallback pulse when analyser unavailable
        const t = Date.now()/600;
        const r = (Math.sin(t)+1)/2; // 0..1
        const bh = 10 + r * (h*0.3);
        vizCtx.fillStyle = 'rgba(124,58,237,0.6)';
        vizCtx.fillRect(12, h-bh-8, w-24, bh);
      }
    } catch {}
    vizAnimId = requestAnimationFrame(draw);
  };
  vizAnimId = requestAnimationFrame(draw);
}
function vizStop(){
  try{ if (vizAnimId) cancelAnimationFrame(vizAnimId); } catch {}
  vizAnimId = null;
  if (vizCtx && vizCanvas){ vizCtx.clearRect(0,0,vizCanvas.width,vizCanvas.height); }
}

function log(msg){
  const t = new Date().toISOString().substring(11,19);
  logEl.textContent += `\n${t} | ${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

// Global error surface to Logs panel
try {
  window.addEventListener('error', (ev) => {
    try { log(`HATA: ${ev.message} @ ${ev.filename}:${ev.lineno}`); } catch {}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { log(`HATA (promise): ${ev.reason && (ev.reason.message || ev.reason)}`); } catch {}
  });
} catch {}

// Signal UI readiness
try { log('UI hazır'); } catch {}
try { const t = document.getElementById('btnToggleMic'); if (t){ t.disabled = false; log('Mikrofon toggle hazır'); } } catch {}

// Replay last response handler will be attached after btnReplay is declared

// ---- Preference selectors (voice / language / correction) ----
const voiceSelect = document.getElementById('voiceSelect');
const scenarioSelect = document.getElementById('scenarioSelect');
const learnLangSelect = document.getElementById('learnLangSelect');
const nativeLangSelect = document.getElementById('nativeLangSelect');
const corrSelect = document.getElementById('corrSelect');

// Populate language selects with a curated list of languages known to have good ASR/TTS quality
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
    // If already populated, skip
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
try { populateLanguageSelects(); } catch {}

// Preload header pills (plan / usage / placement level) before any WS connection
async function preloadPills(){
  try {
    const token = localStorage.getItem('hk_token');
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    // /me -> plan + placementLevel
    try {
      const mr = await fetch(`${backendBase}/me`, { headers });
      if (mr.ok){
        const me = await mr.json();
        const p = document.getElementById('statusPlan');
        const badge = document.getElementById('placementBadge');
        if (p) p.textContent = `Plan: ${me.plan || 'free'}`;
        if (badge) badge.textContent = `Seviye: ${me.placementLevel || '-'}`;
        // Also preload preference selects to user's saved values
        try{
          const learnSel = document.getElementById('learnLangSelect');
          const nativeSel = document.getElementById('nativeLangSelect');
          const voiceSel = document.getElementById('voiceSelect');
          if (learnSel && me.preferredLearningLanguage){ learnSel.value = me.preferredLearningLanguage; }
          if (nativeSel && me.preferredNativeLanguage){ nativeSel.value = me.preferredNativeLanguage; }
          if (voiceSel && me.preferredVoice){ voiceSel.value = me.preferredVoice; }
        } catch {}
      }
    } catch {}
    // /usage -> used/limits
    try {
      const ur = await fetch(`${backendBase}/usage`, { headers });
      if (ur.ok){
        const u = await ur.json();
        const d = document.getElementById('limitDaily');
        const m = document.getElementById('limitMonthly');
        if (d) d.textContent = `Günlük: ${(u.usedDaily||0).toFixed(1)}/${u.limits?.daily ?? '-'} dk`;
        if (m) m.textContent = `Aylık: ${(u.usedMonthly||0).toFixed(1)}/${u.limits?.monthly ?? '-'} dk`;
      }
    } catch {}
  } catch {}
}
try { preloadPills(); } catch {}

async function persistPrefs(partial){
  try{
    const token = localStorage.getItem('hk_token');
    if (token){
      await fetch(`${backendBase}/me/preferences`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(partial) });
    }
  }catch{}
}

function sendPrefsToWs(){
  try{
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const voice = voiceSelect && voiceSelect.value ? voiceSelect.value : 'alloy';
    const learnLang = learnLangSelect && learnLangSelect.value ? learnLangSelect.value : 'tr';
    const nativeLang = nativeLangSelect && nativeLangSelect.value ? nativeLangSelect.value : 'tr';
    const correction = corrSelect && corrSelect.value ? corrSelect.value : 'gentle';
    const scenarioId = scenarioSelect && scenarioSelect.value ? scenarioSelect.value : '';
    const payload = { type: 'set_prefs', prefs: { voice, learnLang, nativeLang, correction, scenarioId } };
    ws.send(JSON.stringify(payload));
    log(`Tercihler güncellendi: voice=${voice}, learn=${learnLang}, native=${nativeLang}, corr=${correction}, scenario=${scenarioId||'-'}`);
  } catch(e){ log('Tercih gönderim hatası: '+(e.message||e)); }
}

if (voiceSelect){
  voiceSelect.addEventListener('change', async () => {
    const voice = voiceSelect.value || 'alloy';
    try {
      if (ws && ws.readyState === WebSocket.OPEN){
        ws.send(JSON.stringify({ type: 'session.update', session: { voice } }));
        sendPrefsToWs();
        log(`Ses tonu: ${voice}`);
      } else {
        log('Önce WS bağlantısı kurun.');
      }
    } catch (e){ log('Ses tonu hatası: '+(e.message||e)); }
    await persistPrefs({ preferredVoice: voice });
  });
}

if (learnLangSelect){
  learnLangSelect.addEventListener('change', async () => {
    const preferredLearningLanguage = learnLangSelect.value || 'tr';
    sendPrefsToWs();
    await persistPrefs({ preferredLearningLanguage });
  });
}

if (nativeLangSelect){
  nativeLangSelect.addEventListener('change', async () => {
    const preferredNativeLanguage = nativeLangSelect.value || 'tr';
    sendPrefsToWs();
    await persistPrefs({ preferredNativeLanguage });
  });
}

if (corrSelect){
  corrSelect.addEventListener('change', async () => {
    const preferredCorrectionMode = corrSelect.value || 'gentle';
    sendPrefsToWs();
    await persistPrefs({ preferredCorrectionMode });
  });
}

// Populate scenarios
async function populateScenarios(){
  try{
    if (!scenarioSelect) return;
    // Only fetch once if already populated beyond placeholder
    if (scenarioSelect.options && scenarioSelect.options.length > 1) return;
    const r = await fetch(`${backendBase}/scenarios`);
    if (!r.ok) return;
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    items.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.title} ${s.level ? '('+s.level+')' : ''}`;
      scenarioSelect.appendChild(opt);
    });
  } catch {}
}
try { populateScenarios(); } catch {}

if (scenarioSelect){
  scenarioSelect.addEventListener('change', async () => {
    // Not persisted to /me/preferences; scenario is a runtime-only preference
    sendPrefsToWs();
  });
}

function updateStatus(){
  if (statusConnEl){
    const open = ws && ws.readyState === WebSocket.OPEN;
    statusConnEl.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`;
  }
  if (statusMicEl){
    statusMicEl.textContent = `Mikrofon: ${wsMicStream ? 'Açık' : 'Kapalı'}`;
  }
}

async function connect(){
  if (pc) return;
  $('#btnConnect').disabled = true;
  try {
    // 1) ephemeral token
    const r = await fetch(`${backendBase}/realtime/ephemeral`, { method: 'POST', headers: { 'Content-Type': 'application/json' }});
    if (!r.ok) throw new Error(`ephemeral failed: ${r.status}`);
    const { client_secret: token, model } = await r.json();
    if (!token) throw new Error('empty token');

    // 2) PeerConnection
    pc = new RTCPeerConnection({
      sdpSemantics: 'unified-plan',
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pc.onconnectionstatechange = () => log(`pc: ${pc.connectionState}`);
    pc.oniceconnectionstatechange = () => log(`ice: ${pc.iceConnectionState}`);
    pc.ontrack = (ev) => {
      if (ev.track.kind === 'audio') {
        $('#remoteAudio').srcObject = ev.streams[0];
        log('ontrack: audio attached');
      }
    };

    // 3) negotiated data channel id=0
    dc = pc.createDataChannel('oai-events', { negotiated: true, id: 0 });
    dc.onopen = () => { log('dc: open'); $('#btnHello').disabled = false; $('#btnMicOn').disabled = false; $('#btnMicOff').disabled = false; };
    dc.onclose = () => { log('dc: close'); $('#btnHello').disabled = true; };
    dc.onmessage = (e) => log(`dc msg: ${e.data}`);

    // 4) default: recv-only; mic on ile sendrecv'e geçeriz
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // 5) create & post offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // short wait for ICE gathering complete
    await waitIce(pc, 3000);
    const local = pc.localDescription;

    const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model || 'gpt-4o-realtime-preview')}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp',
        Accept: 'application/sdp',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: local.sdp,
    });
    if (!sdpRes.ok) throw new Error(`SDP exchange failed: ${sdpRes.status}`);
    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    $('#btnDisconnect').disabled = false;
    log('connected');
  } catch (e){
    log(`error: ${e.message || e}`);
    $('#btnConnect').disabled = false;
    await disconnect();
  }
}

async function sayHello(){
  if (!dc || dc.readyState !== 'open') return;
  await new Promise(r => setTimeout(r, 500));
  const obj = {
    type: 'response.create',
    response: {
      modalities: ['audio','text'],
      instructions: 'Kısaca Türkçe merhaba de.'
    }
  };
  dc.send(JSON.stringify(obj));
  log('prompt sent');
}

async function disconnect(){
  try {
    if (dc){ dc.close(); dc = null; }
    if (pc){ pc.close(); pc = null; }
    if (localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  } catch {}
  $('#btnConnect').disabled = false;
  $('#btnHello').disabled = true;
  $('#btnDisconnect').disabled = true;
  $('#btnMicOn').disabled = true;
  $('#btnMicOff').disabled = true;
  $('#micStatus').textContent = 'mic: off';
  log('disconnected');
}

function waitIce(pc, timeoutMs){
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete'){ clearTimeout(t); resolve(); }
    };
  });
}

{ const el = $('#btnConnect'); if (el) el.addEventListener('click', connect); }
{ const el = $('#btnHello'); if (el) el.addEventListener('click', sayHello); }
{ const el = $('#btnDisconnect'); if (el) el.addEventListener('click', disconnect); }

async function micOn(){
  if (!pc) return;
  try {
    if (!localStream){
      localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
    // addTrack (creates/sendrecv m-line). Some browsers require replacing transceiver.
    localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));
    $('#micStatus').textContent = 'mic: on';
    try { document.body.classList.add('mic-on'); } catch {}
    log('mic: on');
  } catch (e){
    log('mic error: '+ (e.message || e));
  }
}

async function micOff(){
  if (!pc) return;
  try {
    // Remove all local audio senders
    const senders = pc.getSenders ? pc.getSenders() : [];
    senders.filter(s => s.track && s.track.kind === 'audio').forEach(s => pc.removeTrack(s));
    if (localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    $('#micStatus').textContent = 'mic: off';
    try { document.body.classList.remove('mic-on'); } catch {}
    log('mic: off');
  } catch (e){
    log('mic off error: '+ (e.message || e));
  }
}

{ const el = $('#btnMicOn'); if (el) el.addEventListener('click', micOn); }
{ const el = $('#btnMicOff'); if (el) el.addEventListener('click', micOff); }

// ---- WebSocket (Proxy) Transport ----
async function wsConnect(){
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    // start session
    // Determine plan & authorization
    let token = localStorage.getItem('hk_token');
    let planToUse = 'free';
    if (token){
      try {
        const mr = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (mr.ok){ const me = await mr.json(); if (me && me.plan) planToUse = me.plan; }
      } catch {}
    }
    const headers = { 'Content-Type':'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${backendBase}/session/start`, { method: 'POST', headers, body: JSON.stringify({ plan: planToUse }) });
    if (!r.ok){
      if (r.status === 403){
        try {
          const j = await r.json();
          if (j?.error === 'limit_reached'){
            log('WS: Kullanım limitiniz dolmuş görünüyor.');
            const card = document.querySelector('.card');
            if (card){
              const wrapper = document.createElement('div');
              wrapper.className = 'row';
              wrapper.style.marginTop = '8px';
              const info = document.createElement('div');
              info.className = 'subtle';
              info.innerHTML = `Günlük/Aylık limit aşıldı. Kullanım: gün ${(j.minutesUsedDaily||0).toFixed?.(1) ?? j.minutesUsedDaily}/${j.minutesLimitDaily} dk, ay ${(j.minutesUsedMonthly||0).toFixed?.(1) ?? j.minutesUsedMonthly}/${j.minutesLimitMonthly} dk.`;
              const btn = document.createElement('a');
              btn.href = '/#pricing'; btn.className = 'btn btn-primary'; btn.textContent = 'Planları Gör';
              wrapper.appendChild(info); wrapper.appendChild(btn);
              card.appendChild(wrapper);
            }
            return; // do not proceed
          }
        } catch {}
      }
      throw new Error(`session start failed: ${r.status}`);
    }
    const j = await r.json();
    const { sessionId, wsUrl, plan, minutesLimitDaily, minutesLimitMonthly, minutesUsedDaily, minutesUsedMonthly } = j;
    // remember plan for CTAs
    window.__hk_current_plan = plan || 'free';
    // Update UI pills
    const p = document.getElementById('statusPlan');
    const d = document.getElementById('limitDaily');
    const m = document.getElementById('limitMonthly');
    if (p) p.textContent = `Plan: ${plan || 'free'}`;
    if (d) d.textContent = `Günlük: ${minutesUsedDaily ?? 0}/${minutesLimitDaily ?? '-'} dk`;
    if (m) m.textContent = `Aylık: ${minutesUsedMonthly ?? 0}/${minutesLimitMonthly ?? '-'} dk`;
    const url = wsUrl.startsWith('ws') ? wsUrl : `${backendBase.replace('http','ws')}${wsUrl}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = async () => {
      log('WS: open');
      try { const el=$('#btnWsDisconnect'); if (el) el.disabled = false; } catch {}
      try { const el=$('#btnWsMicOn'); if (el) el.disabled = false; } catch {}
      try { const el=$('#btnWsCommit'); if (el) el.disabled = false; } catch {}
      try { const el=$('#btnWsTts'); if (el) el.disabled = false; } catch {}
      updateStatus();
      // Ensure playback context is ready upon connection
      try { wsEnsurePlaybackCtx(); if (wsPlaybackCtx.state === 'suspended') await wsPlaybackCtx.resume(); } catch {}
      try {
        const voiceSel = document.getElementById('voiceSelect');
        const voice = voiceSel && voiceSel.value ? voiceSel.value : 'alloy';
        if (voice){
          ws.send(JSON.stringify({ type: 'session.update', session: { voice } }));
          log(`Ses tonu ayarlandı: ${voice}`);
        }
        // Also push language and correction preferences immediately
        sendPrefsToWs();
      } catch {}
      // toggle pro badge if applicable
      try {
        const badge = document.getElementById('proBadge');
        if (badge && (window.__hk_current_plan || 'free') === 'pro') badge.style.display = 'inline-block';
      } catch {}
      if (wsStartRequested){
        try {
          await wsStartMic();
          micToggleOn = true;
          const btnToggleMicAuto = document.getElementById('btnToggleMic');
          if (btnToggleMicAuto){ btnToggleMicAuto.textContent = 'Mikrofon Kapat'; }
          updateStatus();
          $('#btnStopTalk') && ($('#btnStopTalk').disabled = false);
        } catch{}
      }
      // Allow toggling mic after connection
      const btnToggleMic = document.getElementById('btnToggleMic');
      if (btnToggleMic){ btnToggleMic.disabled = false; }
      // Update placement badge from /me
      try{
        const token = localStorage.getItem('hk_token');
        if (token){
          const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` }});
          if (r.ok){
            const me = await r.json();
            const badge = document.getElementById('placementBadge');
            if (badge){ badge.textContent = `Seviye: ${me.placementLevel || '-'}`; }
          }
        }
      }catch{}
      // Sync session prefs on open and, if Start is requested, auto-start mic
      try{
        // Send full preferences first (voice, learnLang, nativeLang, correction, scenario)
        try { sendPrefsToWs(); } catch {}
        if (wsStartRequested){
          try { wsEnsurePlaybackCtx(); if (wsPlaybackCtx.state === 'suspended') await wsPlaybackCtx.resume(); } catch {}
          await wsStartMic();
          const btnStopTalk = document.getElementById('btnStopTalk');
          if (btnStopTalk){ btnStopTalk.disabled = false; btnStopTalk.style.pointerEvents = 'auto'; }
          updateStatus();
          log('WS open -> mic başlatıldı (auto)');
        }
      } catch (e){ log('Auto mic hata: '+(e.message||e)); }
    };
    ws.onclose = () => {
      log('WS: close');
      try { const el = $('#btnWsDisconnect'); if (el) el.disabled = true; } catch {}
      try { const el = $('#btnWsMicOn'); if (el) el.disabled = true; } catch {}
      try { const el = $('#btnWsMicOff'); if (el) el.disabled = true; } catch {}
      try { const el = $('#btnWsCommit'); if (el) el.disabled = true; } catch {}
      try { const el = $('#btnWsTts'); if (el) el.disabled = true; } catch {}
      ws = null;
      try { wsStopMic(); } catch {}
      try { updateStatus(); } catch {}
      try { const el = $('#btnStopTalk'); if (el) el.disabled = true; } catch {}
      const btnToggleMic = document.getElementById('btnToggleMic');
      if (btnToggleMic){ btnToggleMic.disabled = true; btnToggleMic.textContent = 'Mikrofon Aç'; }
      try { const el = $('#btnStartTalk'); if (el) el.disabled = false; } catch {}
      wsStartRequested = false;
    };
    ws.onerror = (e) => log('WS error');
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        log('WS msg: '+ev.data);
        try {
          const obj = JSON.parse(ev.data);
          if (obj && obj.type) {
            if (obj.type === 'usage_update' && obj.usage){
              const d = document.getElementById('limitDaily');
              const m = document.getElementById('limitMonthly');
              if (d) d.textContent = `Günlük: ${(obj.usage.usedDaily||0).toFixed(1)}/${obj.usage.limits?.daily ?? '-'} dk`;
              if (m) m.textContent = `Aylık: ${(obj.usage.usedMonthly||0).toFixed(1)}/${obj.usage.limits?.monthly ?? '-'} dk`;
            }
            if (obj.type === 'limit_reached'){
              log('LİMİT: kullanım limiti aşıldı. Plan yükseltin veya yarın tekrar deneyin.');
              try{ wsMicOff(); }catch{}
              const wrapper = document.createElement('div');
              wrapper.className = 'row';
              wrapper.style.marginTop = '8px';
              const info = document.createElement('div');
              info.className = 'subtle';
              info.innerHTML = `Limit aşıldı.`;
              const btn = document.createElement('button');
              btn.className = 'btn btn-primary';
              const cur = window.__hk_current_plan || 'free';
              const nextPlan = (cur === 'starter') ? 'pro' : 'starter';
              btn.textContent = (nextPlan === 'pro') ? 'Pro’ya Geç' : 'Starter’a Geç';
              btn.addEventListener('click', async () => {
                const token = localStorage.getItem('hk_token');
                if (!token){
                  alert('Devam etmek için giriş yapın. Ana sayfaya yönlendiriyorum.');
                  window.location.href = '/#pricing';
                  return;
                }
                try{
                  const r = await fetch(`${backendBase}/api/paytr/checkout`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ plan: nextPlan }) });
                  const j = await r.json();
                  if (j?.iframe_url){ window.location.href = j.iframe_url; return; }
                  alert(j?.error || 'Ödeme başlatılamadı');
                }catch(e){ alert('Bağlantı hatası'); }
              });
              const link = document.createElement('a');
              link.href = '/#pricing';
              link.className = 'btn btn-secondary';
              link.textContent = 'Planları Gör';
              wrapper.appendChild(info);
              wrapper.appendChild(btn);
              wrapper.appendChild(link);
              const card = document.querySelector('.card');
              if (card) card.appendChild(wrapper);
            }
            if (obj.type === 'bot_speaking') {
              if (wsForceSilence){ return; }
              // new response starting, reset any previous buffer
              wsAudioChunks = [];
              // allow barge-in: do NOT stop mic; just mark speaking state
              wsBotSpeaking = true;
              try{ vizStart(); }catch{}
            }
            if (obj.type === 'audio_end') {
              // concatenate and play
              if (!wsForceSilence && wsAudioChunks.length > 0) {
                const total = wsAudioChunks.reduce((s, a) => s + a.byteLength, 0);
                const merged = new Uint8Array(total);
                let off = 0;
                for (const chunk of wsAudioChunks) {
                  merged.set(new Uint8Array(chunk), off);
                  off += chunk.byteLength;
                }
                log(`playback: ${wsAudioChunks.length} chunks, total ${total} bytes`);
                lastResponseBuffer = merged.buffer;
                try{ const btnReplay = document.getElementById('btnReplay'); if (btnReplay) btnReplay.disabled = false; }catch{}
                wsPlayPcm(lastResponseBuffer);
                wsAudioChunks = [];
              } else {
                // force-silenced: just drop
                wsAudioChunks = [];
              }
              // mark bot finished
              wsBotSpeaking = false;
              try{ vizStop(); }catch{}
            }
          }
        } catch {}
      } else {
        // binary PCM from server -> buffer until audio_end
        if (!wsForceSilence) {
          wsAudioChunks.push(ev.data);
          // Auto finalize after short inactivity window if server doesn't send audio_end
          try { if (wsAutoEndTimer) clearTimeout(wsAutoEndTimer); } catch {}
          wsAutoEndTimer = setTimeout(() => {
            try {
              if (wsAudioChunks.length === 0) return;
              // Merge chunks into a single Int16 buffer
              let totalSamples = 0;
              const parts = wsAudioChunks.map((ab) => new Int16Array(ab));
              for (const p of parts) totalSamples += p.length;
              const merged = new Int16Array(totalSamples);
              let off = 0;
              for (const p of parts) { merged.set(p, off); off += p.length; }
              lastResponseBuffer = merged.buffer;
              try{ const btnReplay = document.getElementById('btnReplay'); if (btnReplay) btnReplay.disabled = false; }catch{}
              if (!wsForceSilence) wsPlayPcm(lastResponseBuffer);
              wsAudioChunks = [];
              wsBotSpeaking = false;
              try{ vizStop(); }catch{}
              log('Auto-finalize: audio_end (synthetic)');
            } catch {}
          }, 900);
        }
      }
    };
  } catch (e){ log('WS connect error: '+(e.message||e)); }
}

function wsStop(){
  wsForceSilence = true;
  try { if (ws) ws.close(); } catch {}
}

async function wsMicOn(){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    await wsStartMic();
    $('#btnWsMicOn').disabled = true; $('#btnWsMicOff').disabled = false;
    updateStatus();
  } catch (e){ log('WS mic error: '+(e.message||e)); }
}

function wsMicOff(){
  wsStopMic();
  $('#btnWsMicOn').disabled = false; $('#btnWsMicOff').disabled = true;
  updateStatus();
  const btnToggleMic = document.getElementById('btnToggleMic');
  if (btnToggleMic){ btnToggleMic.textContent = 'Mikrofon Aç'; micToggleOn = false; }
}

async function wsStartMic(){
  try {
    log('Mikrofon başlatılıyor...');
    wsMicStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true } });
  } catch (e){
    log('Mikrofon izni/erişimi hatası: '+ (e && (e.message || e.name || e)));
    return;
  }
  try {
    wsAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  } catch(e){
    log('AudioContext oluşturma hatası: '+ (e.message || e));
    try { wsMicStream && wsMicStream.getTracks().forEach(t => t.stop()); } catch {}
    wsMicStream = null;
    return;
  }
  // Warm up playback context early (user gesture window) to avoid autoplay blocks
  try {
    wsEnsurePlaybackCtx();
    // Play a very short silent buffer to unlock audio output
    const silent = wsPlaybackCtx.createBuffer(1, 240, 24000);
    const src = wsPlaybackCtx.createBufferSource();
    src.buffer = silent;
    const g = wsPlaybackCtx.createGain();
    g.gain.value = 0.0001;
    src.connect(g); g.connect(wsPlaybackCtx.destination);
    try { if (wsPlaybackCtx.state === 'suspended') await wsPlaybackCtx.resume(); } catch {}
    src.start(0);
  } catch {}
  wsSource = wsAudioCtx.createMediaStreamSource(wsMicStream);
  // ScriptProcessor fallback (deprecated but widely supported)
  wsProcessor = wsAudioCtx.createScriptProcessor(4096, 1, 1);
  wsProcessor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // Simple VAD: energy threshold
    let energy = 0;
    for (let i = 0; i < input.length; i++) energy += Math.abs(input[i]);
    energy /= input.length;
    const chunkMs = (input.length / 24000) * 1000;
    // Start of speech: if not streaming, after cooldown, and energy above threshold
    const nowMs = Date.now();
    // Raise threshold slightly to avoid false positives
    const speakThreshold = 0.02;
    if (!wsMicStreaming && nowMs >= wsNoStartUntil && energy > speakThreshold) {
      if (wsBotSpeaking && !wsBargeInConfirmed) {
        // Start debounce window (~200ms) to confirm user intent before cancelling bot
        if (!wsBargeInPending) {
          wsBargeInPending = true;
          wsBargeInTimer = setTimeout(() => {
            try {
              // Confirm barge-in
              if (wsPlaybackSource) { try { wsPlaybackSource.stop(); } catch {} wsPlaybackSource = null; }
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'response.cancel' }));
                log('Barge-in: response.cancel gönderildi (200ms)');
              }
              wsBotSpeaking = false;
              wsBargeInConfirmed = true;
            } catch {}
            wsBargeInPending = false; wsBargeInTimer = null;
          }, 200);
        }
        // Do not start mic until barge-in confirmed
      } else {
        // Either bot not speaking or already confirmed barge-in -> start mic
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_start', format: 'pcm16', sampleRate: 24000, channels: 1 })); } catch {}
        wsMicStreaming = true;
        wsVadSpeaking = true;
        wsVadSilenceMs = 0;
        wsBytesSinceStart = 0;
        log('VAD: voice start');
      }
    } else if (energy <= speakThreshold && wsBargeInPending) {
      // Cancel pending barge-in if energy drops before confirm
      try { if (wsBargeInTimer) clearTimeout(wsBargeInTimer); } catch {}
      wsBargeInPending = false; wsBargeInTimer = null;
    }
    // If streaming, send PCM
    const pcm = floatTo16BitPCM(input);
    if (ws && ws.readyState === WebSocket.OPEN && wsMicStreaming) {
      ws.send(pcm);
      wsBytesSinceStart += pcm.byteLength;
    }
    // Silence tracking to auto-commit
    if (energy < 0.005) {
      wsVadSilenceMs += chunkMs;
      if (wsMicStreaming && wsVadSilenceMs >= 600 && wsBytesSinceStart >= 4800) {
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {}
        log('VAD: voice stop (commit)');
        wsMicStreaming = false;
        wsVadSpeaking = false;
        wsVadSilenceMs = 0;
        wsBytesSinceStart = 0;
        wsNoStartUntil = Date.now() + 700; // small cooldown to avoid immediate re-start & empty commits
      }
    } else {
      wsVadSilenceMs = 0;
    }
  };
  wsSource.connect(wsProcessor);
  // Connect to destination to drive onaudioprocess; we do NOT write to output, so no feedback
  wsProcessor.connect(wsAudioCtx.destination);
  // inform server start
  // initial streaming will now be started by VAD when speech detected
  try { document.body.classList.add('mic-on'); } catch {}
  log('Mikrofon hazır (VAD bekliyor)');
}

function wsStopMic(){
  try { if (wsMicStreaming && ws) ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {}
  try { if (wsProcessor) wsProcessor.disconnect(); } catch {}
  try { if (wsSource) wsSource.disconnect(); } catch {}
  try { if (wsAudioCtx) wsAudioCtx.close(); } catch {}
  try { if (wsMicStream) wsMicStream.getTracks().forEach(t => t.stop()); } catch {}
  wsProcessor = null; wsSource = null; wsAudioCtx = null; wsMicStream = null;
  wsMicStreaming = false; wsVadSpeaking = false; wsVadSilenceMs = 0; wsBytesSinceStart = 0;
  wsBargeInPending = false; wsBargeInConfirmed = false; if (wsBargeInTimer) { try { clearTimeout(wsBargeInTimer); } catch {} wsBargeInTimer = null; }
  updateStatus();
  try { document.body.classList.remove('mic-on'); } catch {}
}

function floatTo16BitPCM(float32Array){
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++){
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
    offset += 2;
  }
  return buffer;
}

function wsEnsurePlaybackCtx(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!wsPlaybackCtx || (wsPlaybackCtx && wsPlaybackCtx.state === 'closed')){
    wsPlaybackCtx = new AC({ sampleRate: 24000 });
  }
  if (wsPlaybackCtx.state === 'suspended') wsPlaybackCtx.resume();
}

function wsPlayPcm(arrayBuffer){
  try {
    wsEnsurePlaybackCtx();
    const pcm16 = new Int16Array(arrayBuffer);
    const len = pcm16.length;
    if (len === 0) return;
    const audioBuffer = wsPlaybackCtx.createBuffer(1, len, 24000);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch0[i] = Math.max(-1, Math.min(1, pcm16[i] / 32768));
    }
    // stop previous playback if any
    if (wsPlaybackSource) { try { wsPlaybackSource.stop(); } catch {} }
    const src = wsPlaybackCtx.createBufferSource();
    src.buffer = audioBuffer;
    // apply gentle gain to improve audibility
    const gain = wsPlaybackCtx.createGain();
    gain.gain.value = 1.5; // ~+3.5 dB
    // analyser
    vizAnalyser = wsPlaybackCtx.createAnalyser();
    vizAnalyser.fftSize = 2048; // better time-domain resolution
    vizTimeData = new Uint8Array(vizAnalyser.fftSize);
    src.connect(gain);
    gain.connect(vizAnalyser);
    vizAnalyser.connect(wsPlaybackCtx.destination);
    wsPlaybackSource = src;
    src.start();
  } catch (e){
    log('play error: '+(e.message||e));
  }
}

// wire WS buttons
{ const el = $('#btnWsConnect'); if (el) el.addEventListener('click', wsConnect); }
{ const el = $('#btnWsDisconnect'); if (el) el.addEventListener('click', wsStop); }
{ const el = $('#btnWsMicOn'); if (el) el.addEventListener('click', wsMicOn); }
{ const el = $('#btnWsMicOff'); if (el) el.addEventListener('click', wsMicOff); }
{ const el = $('#btnWsCommit'); if (el) el.addEventListener('click', () => {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (wsMicStreaming) {
      ws.send(JSON.stringify({ type: 'audio_stop' }));
      log('Manual commit (audio_stop)');
      wsMicStreaming = false; wsVadSpeaking = false; wsVadSilenceMs = 0; wsBytesSinceStart = 0;
    } else {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      log('Manual commit (explicit)');
    }
  } catch (e){ log('Commit error: '+(e.message||e)); }
}); }

// ---- WS-first Big Buttons ----
const btnStartTalk = $('#btnStartTalk');
const btnStopTalk = $('#btnStopTalk');
const btnReplay = document.getElementById('btnReplay');
if (btnReplay){
  btnReplay.addEventListener('click', () => {
    try{
      if (lastResponseBuffer) wsPlayPcm(lastResponseBuffer);
    } catch (e){ log('Replay hatası: '+(e.message||e)); }
  });
}
if (btnStartTalk){
  btnStartTalk.addEventListener('click', async () => {
    try {
      log('Start butonuna basıldı');
      btnStartTalk.disabled = true;
      wsStartRequested = true;
      wsForceSilence = false; // allow playback again
      // Stop butonunu hemen aktif et (kullanıcı akışı)
      try {
        const sbtn = document.getElementById('btnStopTalk');
        if (sbtn){ sbtn.disabled = false; sbtn.style.pointerEvents = 'auto'; }
      } catch {}
      // 1) Mikrofonu hemen başlat (user gesture anında) — izin diyaloğu vs. bu aşamada açılır
      await wsStartMic();
      // 1.5) Tercihleri hemen kaydet (server /session/start kişiselleştirmesi için)
      try{
        const voice = (document.getElementById('voiceSelect')?.value) || 'alloy';
        const preferredLearningLanguage = (document.getElementById('learnLangSelect')?.value) || 'en';
        const preferredNativeLanguage = (document.getElementById('nativeLangSelect')?.value) || 'tr';
        const preferredCorrectionMode = (document.getElementById('corrSelect')?.value) || 'gentle';
        await persistPrefs({ preferredVoice: voice, preferredLearningLanguage, preferredNativeLanguage, preferredCorrectionMode });
      } catch {}
      // 2) WS açık değilse bağlan ve açılmasını bekle
      if (!ws || ws.readyState !== WebSocket.OPEN){
        await wsConnect();
        await waitWsOpen(5000);
      }
      if (!ws || ws.readyState !== WebSocket.OPEN){ throw new Error('WS açılamadı'); }
      updateStatus();
      if (btnStopTalk) btnStopTalk.disabled = false;
      log('Konuşma başlatıldı');
    } catch (e){
      log('Başlatma hatası: '+(e.message||e));
      btnStartTalk.disabled = false; wsStartRequested = false;
    }
  });
}

if (btnStopTalk){
  btnStopTalk.addEventListener('click', async () => {
    try {
      wsStartRequested = false;
      wsForceSilence = true; // from now ignore any buffered or incoming audio
      wsMicOff();
      wsStop();
      // Immediately silence any bot audio and viz
      try { if (wsPlaybackSource) { wsPlaybackSource.stop(); wsPlaybackSource = null; } } catch {}
      try { if (wsPlaybackCtx && wsPlaybackCtx.state === 'running') wsPlaybackCtx.suspend(); } catch {}
      try { vizStop(); wsBotSpeaking = false; wsAudioChunks = []; } catch {}
      try { const ra = document.getElementById('remoteAudio'); if (ra){ ra.pause?.(); ra.srcObject = null; } } catch {}
      updateStatus();
      if (btnStartTalk) btnStartTalk.disabled = false;
      btnStopTalk.disabled = true;
      log('Konuşma durduruldu');
    } catch (e){ log('Durdurma hatası: '+(e.message||e)); }
  });
}

// Single mic toggle button
const btnToggleMic = document.getElementById('btnToggleMic');
if (btnToggleMic){
  btnToggleMic.addEventListener('click', async () => {
    try {
      log('Mikrofon toggle tıklandı');
      if (!ws || ws.readyState !== WebSocket.OPEN){
        log('WS kapalı: otomatik bağlanılıyor...');
        await wsConnect();
        if (!ws || ws.readyState !== WebSocket.OPEN){
          log('Bağlantı kurulamadı.');
          return;
        }
      }
      if (!micToggleOn){
        await wsStartMic();
        micToggleOn = true;
        btnToggleMic.textContent = 'Mikrofon Kapat';
        updateStatus();
        log('Mikrofon açıldı');
      } else {
        wsMicOff();
        micToggleOn = false;
        btnToggleMic.textContent = 'Mikrofon Aç';
        updateStatus();
        log('Mikrofon kapatıldı');
      }
    } catch (e){ log('Mic toggle hatası: '+(e.message||e)); }
  });
}

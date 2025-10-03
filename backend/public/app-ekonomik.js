// Economic Plan App - Uses cheaper speech-to-text processing
// Instead of direct WebRTC audio streaming, this converts speech to text first

import { backendBase } from './config.js';

let ws = null;
let wsMicStream = null;
let remoteAudio = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// DOM elements
const btnStartTalk = document.getElementById('btnStartTalk');
const btnStopTalk = document.getElementById('btnStopTalk');
const btnReplay = document.getElementById('btnReplay');
const statusConnEl = document.getElementById('statusConn');
const statusMicEl = document.getElementById('statusMic');
const statusPlanEl = document.getElementById('statusPlan');
const limitDailyEl = document.getElementById('limitDaily');
const remoteAudioEl = document.getElementById('remoteAudio');

// Initialize
try {
  remoteAudio = remoteAudioEl;
  // Load user preferences and limits
  loadUserData();

  // Event listeners
  if (btnStartTalk) btnStartTalk.addEventListener('click', startConversation);
  if (btnStopTalk) btnStopTalk.addEventListener('click', stopConversation);
  if (btnReplay) btnReplay.addEventListener('click', replayLastResponse);

  // Periodic status updates
  setInterval(updateStatus, 1000);

} catch (e) {
  console.error('[app-ekonomik] init error:', e);
}

async function loadUserData() {
  try {
    const token = localStorage.getItem('hk_token');
    if (!token) return;

    const r = await fetch(`${backendBase}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (r.ok) {
      const me = await r.json();
      if (statusPlanEl) statusPlanEl.textContent = `Plan: ${me.user?.plan || 'free'}`;
      if (limitDailyEl) {
        const used = me.usage?.dailyUsed || 0;
        const limit = me.usage?.dailyLimit || 0;
        limitDailyEl.textContent = `Günlük: ${used}/${limit} dk`;
      }
    }
  } catch (e) {
    console.error('[app-ekonomik] loadUserData error:', e);
  }
}

function updateStatus() {
  if (statusConnEl) {
    const open = ws && ws.readyState === WebSocket.OPEN;
    statusConnEl.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`;
  }
  if (statusMicEl) {
    statusMicEl.textContent = `Mikrofon: ${isRecording ? 'Açık' : 'Kapalı'}`;
  }
}

async function startConversation() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[app-ekonomik] already connected');
    return;
  }

  try {
    $('#btnStartTalk').disabled = true;

    // 1) Get session
    const sessionRes = await fetch(`${backendBase}/session/economic/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('hk_token')}`
      }
    });

    if (!sessionRes.ok) {
      const err = await sessionRes.json();
      throw new Error(err.message || `Session failed: ${sessionRes.status}`);
    }

    const { sessionId, wsUrl } = await sessionRes.json();

    // 2) Connect WebSocket (for economic plan - handles text input/output)
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[app-ekonomik] WebSocket connected');
      $('#btnStopTalk').disabled = false;
      $('#btnStartTalk').disabled = true;

      // Start microphone recording for speech-to-text
      startMicrophoneRecording();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {
        console.error('[app-ekonomik] message parse error:', err);
      }
    };

    ws.onclose = (e) => {
      console.log('[app-ekonomik] WebSocket closed:', e.code, e.reason);
      cleanup();
    };

    ws.onerror = (e) => {
      console.error('[app-ekonomik] WebSocket error:', e);
      cleanup();
    };

  } catch (e) {
    console.error('[app-ekonomik] start error:', e);
    alert('Bağlantı başlatılırken hata: ' + e.message);
    $('#btnStartTalk').disabled = false;
  }
}

async function stopConversation() {
  if (!ws) return;

  try {
    // Stop recording
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
    }

    // Close WebSocket
    ws.close();
    ws = null;

    $('#btnStartTalk').disabled = false;
    $('#btnStopTalk').disabled = true;

  } catch (e) {
    console.error('[app-ekonomik] stop error:', e);
  }
}

async function startMicrophoneRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000
      }
    });

    wsMicStream = stream;

    // Use MediaRecorder for audio chunks
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      // Process audio chunk for speech-to-text
      processAudioForSpeechToText();
    };

    // Record in 1 second chunks
    mediaRecorder.start(1000);
    isRecording = true;

  } catch (e) {
    console.error('[app-ekonomik] microphone error:', e);
    alert('Mikrofon erişimi başarısız: ' + e.message);
  }
}

async function processAudioForSpeechToText() {
  if (audioChunks.length === 0) return;

  try {
    // Combine audio chunks
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

    // Here we would integrate with a speech-to-text service like:
    // - Google Speech-to-Text API
    // - Azure Speech Services
    // - OpenAI Whisper API (cheaper than realtime)
    // For demo purposes, we'll simulate this

    console.log('[app-ekonomik] Processing audio for speech-to-text...', audioBlob.size, 'bytes');

    // Simulate speech-to-text processing
    // In real implementation, send to speech-to-text API
    const transcribedText = await simulateSpeechToText(audioBlob);

    if (transcribedText && ws && ws.readyState === WebSocket.OPEN) {
      // Send transcribed text to server
      const message = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: transcribedText
          }]
        }
      };

      ws.send(JSON.stringify(message));
      console.log('[app-ekonomik] Sent transcribed text:', transcribedText);
    }

    // Clear chunks for next recording
    audioChunks = [];

  } catch (e) {
    console.error('[app-ekonomik] speech-to-text error:', e);
  }
}

// Simulate speech-to-text (replace with real API call)
async function simulateSpeechToText(audioBlob) {
  // In real implementation, you would:
  // 1. Send audioBlob to speech-to-text API (e.g., OpenAI Whisper)
  // 2. Return the transcribed text

  // For demo, return some sample text after delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Simulate different responses based on recording length
  const responses = [
    "Merhaba, nasılsınız?",
    "Bugün hava çok güzel.",
    "Türkçe öğrenmek istiyorum.",
    "Lütfen beni düzeltin.",
    "Teşekkür ederim."
  ];

  return responses[Math.floor(Math.random() * responses.length)];
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'conversation.item.created':
      console.log('[app-ekonomik] Item created:', msg.item?.id);
      break;

    case 'conversation.item.input_audio_transcription.completed':
      console.log('[app-ekonomik] Audio transcription completed');
      break;

    case 'response.created':
      console.log('[app-ekonomik] Response created');
      break;

    case 'response.output_item.added':
      console.log('[app-ekonomik] Output item added');
      break;

    case 'response.output_item.done':
      console.log('[app-ekonomik] Output item done');
      break;

    case 'response.done':
      console.log('[app-ekonomik] Response done');
      break;

    case 'usage_update':
      updateUsageDisplay(msg.usage);
      break;

    case 'limit_reached':
      alert('Günlük kullanım limitiniz doldu!');
      stopConversation();
      break;

    default:
      console.log('[app-ekonomik] Unhandled message type:', msg.type);
  }
}

function updateUsageDisplay(usage) {
  if (limitDailyEl && usage) {
    limitDailyEl.textContent = `Günlük: ${usage.usedDaily}/${usage.limits?.daily || 0} dk`;
  }
}

async function replayLastResponse() {
  if (remoteAudio) {
    try {
      remoteAudio.currentTime = 0;
      await remoteAudio.play();
    } catch (e) {
      console.error('[app-ekonomik] replay error:', e);
    }
  }
}

function cleanup() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
  }

  if (wsMicStream) {
    wsMicStream.getTracks().forEach(track => track.stop());
    wsMicStream = null;
  }

  $('#btnStartTalk').disabled = false;
  $('#btnStopTalk').disabled = true;
  $('#btnReplay').disabled = true;

  ws = null;
}

// Helper function
function $(sel) {
  return document.querySelector(sel);
}

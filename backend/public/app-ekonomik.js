// Economic Plan App - Real-time voice conversation with OpenAI Realtime API
// Streams audio directly to OpenAI for speech recognition and voice response

// Get backend base URL from config (same pattern as app.js)
const backendBase = (typeof window !== 'undefined' && window.__BACKEND_BASE__) ? window.__BACKEND_BASE__ : 'https://api.konuskonusabilirsen.com';

let ws = null;
let wsMicStream = null;
let remoteAudio = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioContext = null;
let processor = null;
let audioBufferQueue = [];
let isPlaying = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectDelay = 3000; // Start with 3 seconds
let lastActivity = Date.now();

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
      console.log('[app-ekonomik] User data loaded:', me);

      if (statusPlanEl) statusPlanEl.textContent = `Plan: ${me.user?.plan || 'free'}`;
      if (limitDailyEl) {
        const used = me.usage?.dailyUsed || 0;
        const limit = me.usage?.dailyLimit || 0;
        limitDailyEl.textContent = `Günlük: ${used}/${limit} dk`;
      }

      // Update placement level
      const placementBadgeEl = document.getElementById('placementBadge');
      if (placementBadgeEl && me.user?.placementLevel) {
        placementBadgeEl.textContent = `Seviye: ${me.user.placementLevel}`;
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
    reconnectAttempts = 0; // Reset reconnect attempts for new conversation
    console.log('[app-ekonomik] Starting new conversation...');

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
    console.log('[app-ekonomik] Got session:', sessionId, 'wsUrl:', wsUrl);

    // 2) Connect WebSocket (for economic plan - handles text input/output)
    console.log('[app-ekonomik] Connecting to WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[app-ekonomik] WebSocket connected');
      console.log('[app-ekonomik] WebSocket readyState:', ws.readyState);
      $('#btnStopTalk').disabled = false;
      $('#btnStartTalk').disabled = true;
      reconnectAttempts = 0; // Reset reconnect attempts on successful connection

      // Wait a moment for connection to stabilize before starting recording
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          console.log('[app-ekonomik] Starting microphone recording after connection stabilization...');
          startMicrophoneRecording().catch(error => {
            console.error('[app-ekonomik] Microphone error:', error);
            // Don't alert for microphone errors - user can retry
            console.error('[app-ekonomik] Microphone access failed, but keeping WebSocket alive for retry');
          });
        } else {
          console.error('[app-ekonomik] WebSocket connection lost before recording could start');
        }
      }, 1000);
    };

    ws.onmessage = (e) => {
      try {
        // Update activity timestamp on any message received
        lastActivity = Date.now();

        // Handle binary audio data from OpenAI
        if (e.data instanceof Blob || e.data.constructor.name === 'ArrayBuffer') {
          handleAudioData(e.data);
          return;
        }

        // Handle text messages
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {
        console.error('[app-ekonomik] message parse error:', err);
      }
    };

    ws.onclose = (e) => {
      console.log('[app-ekonomik] WebSocket closed:', e.code, e.reason);
      console.log('[app-ekonomik] WebSocket close event:', e);
      console.log('[app-ekonomik] ws wasClean:', e.wasClean);
      console.log('[app-ekonomik] ws readyState at close:', ws.readyState);

      // Handle different close codes with more detailed logging
      if (e.code === 1005) {
        console.warn('[app-ekonomik] WebSocket closed without status - possible connection issue');
        console.warn('[app-ekonomik] This usually indicates network interruption or server-side issue');
      } else if (e.code === 1006) {
        console.warn('[app-ekonomik] WebSocket closed abnormally - network issue');
        console.warn('[app-ekonomik] Connection lost unexpectedly');
      } else if (e.code === 1008) {
        console.warn('[app-ekonomik] WebSocket closed due to policy violation');
      } else if (e.code === 1011) {
        console.error('[app-ekonomik] WebSocket closed due to server error');
      } else if (e.code === 1000) {
        console.log('[app-ekonomik] WebSocket closed normally');
      } else {
        console.warn(`[app-ekonomik] WebSocket closed with unknown code: ${e.code}`);
      }

      cleanup();

      // Auto-reconnect for certain error codes (but not if user manually stopped)
      if (e.code !== 1000 && typeof startConversation === 'function') { // 1000 = normal closure
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), 30000); // Exponential backoff, max 30s
          console.log(`[app-ekonomik] Auto-reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${delay/1000} seconds...`);

          setTimeout(() => {
            if (!$('#btnStartTalk').disabled) { // Only reconnect if not manually stopped
              console.log('[app-ekonomik] Auto-reconnecting...');
              startConversation().catch(err => {
                console.error('[app-ekonomik] Auto-reconnect failed:', err);
              });
            }
          }, delay);
        } else {
          console.error('[app-ekonomik] Max reconnection attempts reached, giving up');
          $('#btnStartTalk').disabled = false;
          $('#btnStopTalk').disabled = true;
          alert('Bağlantı sorunları yaşanıyor. Lütfen sayfayı yeniden yükleyin.');
        }
      } else {
        // Reset reconnect attempts on normal closure
        reconnectAttempts = 0;
      }
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
    console.log('[app-ekonomik] Requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 24000, // 24kHz for better quality
        channelCount: 1
      }
    });

    console.log('[app-ekonomik] Microphone access granted');
    wsMicStream = stream;

    // Initialize audio context for real-time processing
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000
    });

    const source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const inputBuffer = e.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);

        // Convert to PCM16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }

        // Send audio data to server
        ws.send(pcm16.buffer.slice(), { binary: true });
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isRecording = true;
    console.log('[app-ekonomik] Real-time audio streaming started');

  } catch (e) {
    console.error('[app-ekonomik] microphone error:', e);
    alert('Mikrofon erişimi başarısız: ' + e.message);
  }
}

// Handle incoming audio data from OpenAI
function handleAudioData(audioData) {
  if (!audioContext) {
    console.error('[app-ekonomik] No audio context available for playback');
    return;
  }

  try {
    // Convert ArrayBuffer to AudioBuffer and queue for playback
    audioContext.decodeAudioData(audioData, (buffer) => {
      audioBufferQueue.push(buffer);
      if (!isPlaying) {
        playNextAudioBuffer();
      }
    }, (error) => {
      console.error('[app-ekonomik] Error decoding audio data:', error);
    });
  } catch (e) {
    console.error('[app-ekonomik] Error handling audio data:', e);
  }
}

// Play next audio buffer in queue
function playNextAudioBuffer() {
  if (audioBufferQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const buffer = audioBufferQueue.shift();

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  source.onended = () => {
    playNextAudioBuffer();
  };

  source.start();
}

// Real-time voice conversation - no need for speech-to-text simulation
// OpenAI Realtime API handles speech recognition automatically

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

    case 'system_message':
      console.log('[app-ekonomik] System message:', msg.message);

      // Handle system messages (like switching to text-only mode)
      if (msg.message && msg.message.includes('text-only')) {
        console.log('[app-ekonomik] Switching to text-only mode');

        // Update UI to indicate text-only mode
        if (statusConnEl) {
          statusConnEl.textContent = 'Bağlantı: Metin Modu';
        }

        // Show user notification
        if (msg.message.includes('API key not configured')) {
          console.warn('[app-ekonomik] OpenAI API key not configured - voice features disabled');
        } else {
          console.info('[app-ekonomik] Voice mode unavailable, using text-only mode');
        }
      }
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
  // Stop audio processing
  if (processor) {
    processor.disconnect();
    processor = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }

  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
  }

  if (wsMicStream) {
    wsMicStream.getTracks().forEach(track => track.stop());
    wsMicStream = null;
  }

  // Clear audio buffer queue
  audioBufferQueue = [];
  isPlaying = false;

  // Don't reset button states during cleanup if we're reconnecting
  // Let the reconnection logic handle button states
  if (!$('#btnStartTalk').disabled) {
    $('#btnStartTalk').disabled = false;
  }
  $('#btnStopTalk').disabled = true;
  $('#btnReplay').disabled = true;

  ws = null;
  // Note: Don't reset reconnectAttempts here as it should persist across cleanup calls
}

// Helper function
function $(sel) {
  return document.querySelector(sel);
}

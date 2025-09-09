import 'package:flutter/material.dart';
import 'dart:convert';
import 'dart:async';
import 'package:http/http.dart' as http;
import 'package:flutter/foundation.dart';
import 'dart:io' show Platform;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:record/record.dart';
import 'dart:typed_data';
import 'package:permission_handler/permission_handler.dart';
import 'package:flutter_sound/flutter_sound.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

void main() {
  runApp(const MyApp());
}

class ChatMessage {
  final String role; // 'user' | 'bot' | 'system'
  final String text;
  ChatMessage(this.role, this.text);
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  // This widget is the root of your application.
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Lingoflow',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
      ),
      home: const HomePage(),
    );
  }
}

class SimpleRealtimeDemo extends StatefulWidget {
  const SimpleRealtimeDemo({super.key});

  @override
  State<SimpleRealtimeDemo> createState() => _SimpleRealtimeDemoState();
}

class _SimpleRealtimeDemoState extends State<SimpleRealtimeDemo> {
  RTCPeerConnection? _pc;
  RTCDataChannel? _dc;
  final RTCVideoRenderer _remote = RTCVideoRenderer();
  String _status = 'idle';

  @override
  void initState() {
    super.initState();
    _remote.initialize().then((_) => setState(() {}));
  }

  @override
  void dispose() {
    _remote.srcObject = null;
    _remote.dispose();
    _stop();
    super.dispose();
  }

  Future<void> _connect() async {
    if (_pc != null) return;
    setState(() => _status = 'starting');
    try {
      // 1) Ephemeral token al (backend üzerinden)
      final uri = Uri.parse('${_backendBase()}/realtime/ephemeral');
      final resp = await http.post(uri, headers: {'Content-Type': 'application/json'});
      if (resp.statusCode != 200) {
        throw Exception('Ephemeral token failed: ${resp.statusCode} ${resp.body}');
      }
      final data = jsonDecode(resp.body) as Map<String, dynamic>;
      final token = (data['client_secret'] as String?) ?? '';
      final model = (data['model'] as String?) ?? 'gpt-4o-realtime-preview';
      if (token.isEmpty) throw Exception('Empty ephemeral token');

      // 2) PeerConnection kur
      final pc = await createPeerConnection({
        'sdpSemantics': 'unified-plan',
        'iceServers': [
          {'urls': 'stun:stun.l.google.com:19302'},
        ]
      });
      pc.onConnectionState = (s) => setState(() { _status = 'pc: $s'; });
      pc.onIceConnectionState = (s) => setState(() { _status = 'ice: $s'; });
      pc.onTrack = (ev) async {
        if (ev.track.kind == 'audio') {
          try { await Helper.setSpeakerphoneOn(true); } catch (_) {}
          _remote.srcObject = ev.streams.isNotEmpty ? ev.streams.first : null;
          setState(() {});
        }
      };

      // 3) Negotiated DataChannel (id=0)
      final init = RTCDataChannelInit()
        ..negotiated = true
        ..id = 0;
      final dc = await pc.createDataChannel('oai-events', init);
      dc.onDataChannelState = (s) => setState(() { _status = 'dc: $s'; });
      dc.onMessage = (m) => debugPrint('DC msg: ${m.text}');

      // 4) Offer oluştur ve gönder (dokümantasyon-min): sadece uzak sesten yararlanmak için recv-only
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );

      final offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      // Full ICE SDP için kısa bekleme (opsiyonel)
      await _waitForIceGatheringComplete(pc, timeoutMs: 5000);
      final local = await pc.getLocalDescription();
      final offerSdp = local?.sdp ?? offer.sdp;

      final sdpUri = Uri.parse('https://api.openai.com/v1/realtime?model=$model');
      final sdpResp = await http.post(
        sdpUri,
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/sdp',
          'Accept': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
        body: offerSdp,
      );
      if (sdpResp.statusCode < 200 || sdpResp.statusCode >= 300) {
        throw Exception('SDP exchange failed: ${sdpResp.statusCode} ${sdpResp.body}');
      }
      final answer = RTCSessionDescription(sdpResp.body, 'answer');
      await pc.setRemoteDescription(answer);

      setState(() {
        _pc = pc;
        _dc = dc;
        _status = 'connected';
      });
    } catch (e) {
      setState(() => _status = 'error: $e');
      await _stop();
    }
  }

  Future<void> _promptHello() async {
    final ch = _dc;
    if (ch == null || ch.state != RTCDataChannelState.RTCDataChannelOpen) return;
    try {
      // DC tam stabilize olsun diye küçük bir gecikme koyuyoruz
      await Future.delayed(const Duration(milliseconds: 1000));
      final obj = {
        'type': 'response.create',
        'response': {
          'modalities': ['audio','text'],
          'instructions': 'Kısaca Türkçe merhaba de.'
        }
      };
      ch.send(RTCDataChannelMessage(jsonEncode(obj)));
      setState(() { _status = 'prompt sent'; });
    } catch (e) {
      setState(() { _status = 'dc send error: $e'; });
    }
  }

  Future<void> _stop() async {
    try {
      final pc = _pc; final dc = _dc;
      _pc = null; _dc = null;
      if (dc != null) { await dc.close(); }
      if (pc != null) { await pc.close(); }
      setState(() => _status = 'idle');
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Realtime (Minimal)')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Backend: '+_backendBase(), style: const TextStyle(fontSize: 12, color: Colors.black54)),
            const SizedBox(height: 8),
            Text('Status: $_status'),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              ElevatedButton(onPressed: _pc == null ? _connect : null, child: const Text('Connect')),
              ElevatedButton(onPressed: (_dc?.state == RTCDataChannelState.RTCDataChannelOpen) ? _promptHello : null, child: const Text('Say Hello')),
              ElevatedButton(onPressed: _pc != null ? _stop : null, child: const Text('Disconnect')),
            ]),
            const SizedBox(height: 16),
            if (_remote.renderVideo)
              Expanded(
                child: RTCVideoView(_remote, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain),
              ),
          ],
        ),
      ),
    );
  }

  String _backendBase() {
    // Basit varsayılanlar: Android emülatöründe 10.0.2.2; diğerlerinde localhost
    try {
      if (Platform.isAndroid) return 'http://10.0.2.2:8080';
    } catch (_) {}
    if (kIsWeb) return 'http://localhost:8080';
    return 'http://localhost:8080';
  }

  Future<void> _waitForIceGatheringComplete(RTCPeerConnection pc, {int timeoutMs = 3000}) async {
    if (pc.iceGatheringState == RTCIceGatheringState.RTCIceGatheringStateComplete) return;
    final c = Completer<void>();
    final prev = pc.onIceGatheringState;
    pc.onIceGatheringState = (s) {
      if (prev != null) prev(s);
      if (s == RTCIceGatheringState.RTCIceGatheringStateComplete && !c.isCompleted) {
        c.complete();
      }
    };
    final t = Timer(Duration(milliseconds: timeoutMs), () {
      if (!c.isCompleted) c.complete();
    });
    await c.future;
    t.cancel();
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  String _health = 'Unknown';
  String? _sessionId;
  String? _wsUrl;
  String _selectedMode = 'Free Talk';
  bool _loadingHealth = false;
  bool _loadingSession = false;
  WebSocketChannel? _channel;
  final List<String> _logs = [];
  bool _connected = false;
  final ScrollController _scrollCtrl = ScrollController();
  final List<ChatMessage> _messages = [];
  final TextEditingController _textCtrl = TextEditingController();
  // Speech
  late final stt.SpeechToText _speech;
  late final FlutterTts _tts;
  bool _listening = false;
  bool _serverSpeech = false; // Use server STT/TTS via PCM over WS
  String _sttLocale = 'tr-TR';
  List<stt.LocaleName> _locales = const [];
  String _sttStatus = 'idle';
  double _soundLevel = 0.0;
  String _partialText = '';
  bool _continuousListen = true; // true: sürekli dinleme, false: bas-konuş
  bool _sentFromThisListen = false;
  // backend override
  String? _backendOverride; // e.g., http://192.168.1.10:8080
  final TextEditingController _backendCtrl = TextEditingController();
  // auto-retry
  int _retryAttempt = 0;
  Timer? _retryTimer;
  // auto-relisten for continuous mode
  Timer? _relistenTimer;
  // commit debounce for continuous mode
  Timer? _commitTimer;
  String? _pendingFinal;
  // watchdog to enforce continuous listening
  Timer? _ensureListeningTimer;
  // mic stream for server speech mode (record)
  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _micSub;
  static const int _micSampleRate = 16000; // 16kHz mono PCM16
  // audio player for server TTS
  late final FlutterSoundPlayer _player;
  bool _playerReady = false;
  static const int _playerSampleRate = 16000;
  // Suppress mic frames while bot audio is playing to avoid feedback/echo
  bool _suppressMic = false;
  Timer? _botSilenceTimer;
  // Simple jitter buffer for bot audio to smooth out chunk boundaries
  Uint8List _botAudioBuffer = Uint8List(0);
  Timer? _botAudioFlushTimer;
  DateTime? _lastUiUpdate; // throttle frequent UI refreshes during audio streaming
  // Simple VAD state
  bool _sendMic = false; // true while we consider user speaking
  int _silenceMs = 0;
  // Increased to reduce premature commits on short pauses
  static const int _silenceStopMs = 1200; // stop after 1.2s silence
  static const int _pcmBytesPerSample = 2;
  static const int _vadSilenceThreshold = 300; // avg abs amplitude threshold

  // WebRTC (OpenAI Realtime) state
  bool _useWebRTC = false;
  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  RTCDataChannel? _dc;
  String _webrtcStatus = 'idle';
  // Remote audio renderer (audio-only). Keeping a renderer attached ensures audio plays on Android.
  final RTCVideoRenderer _remoteRenderer = RTCVideoRenderer();
  bool _rendererReady = false;

  // Backend base URL: Web/Windows -> localhost, Android emulator -> 10.0.2.2
  String get backendBase {
    if (_backendOverride != null && _backendOverride!.isNotEmpty) {
      return _backendOverride!;
    }
    if (kIsWeb) return 'http://localhost:8080';
    try {
      if (Platform.isAndroid) return 'http://10.0.2.2:8080';
    } catch (_) {
      // Platform may be unsupported in some targets (e.g., web stubs)
    }
    return 'http://localhost:8080';
  }

  Future<void> _waitForIceGatheringComplete(RTCPeerConnection pc, {int timeoutMs = 3000}) async {
    if (pc.iceGatheringState == RTCIceGatheringState.RTCIceGatheringStateComplete) return;
    final c = Completer<void>();
    final prevHandler = pc.onIceGatheringState;
    void handler(RTCIceGatheringState state) {
      _appendLog('ICE gathering: $state');
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete && !c.isCompleted) {
        c.complete();
      }
    }
    pc.onIceGatheringState = (s) {
      if (prevHandler != null) prevHandler(s);
      handler(s);
    };
    final t = Timer(Duration(milliseconds: timeoutMs), () {
      if (!c.isCompleted) c.complete();
    });
    await c.future;
    t.cancel();
  }

  @override
  void initState() {
    super.initState();
    // Auto-check backend health on startup for better UX
    // ignore: discarded_futures
    checkHealth();
    _speech = stt.SpeechToText();
    _tts = FlutterTts();
    _player = FlutterSoundPlayer();
    _initTts();
    // ignore: discarded_futures
    _initPlayer();
    _loadPrefs();
    // Init WebRTC remote renderer
    _remoteRenderer.initialize().then((_) {
      setState(() => _rendererReady = true);
    });
    // Emülatör için: WebRTC yerine otomatik WS ses akışını başlat
    // Kısa gecikme ile backend health sonrası session/WS/mic akışını açıyoruz
    Future.delayed(const Duration(milliseconds: 400), () async {
      try {
        // WebRTC kapalı, sunucu konuşma açık olsun
        setState(() {
          _useWebRTC = false;
          _serverSpeech = true;
        });
        // Session başlat
        await startSession();
        // WS bağlan
        await _connectWebSocket();
        // Mic streaming başlat
        await _startServerAudio();
      } catch (_) {}
    });
  }

  @override
  void dispose() {
    _channel?.sink.close();
    _textCtrl.dispose();
    _tts.stop();
    _retryTimer?.cancel();
    _relistenTimer?.cancel();
    _commitTimer?.cancel();
    _ensureListeningTimer?.cancel();
    _player.closePlayer();
    _botAudioFlushTimer?.cancel();
    _botAudioFlushTimer = null;
    if (_rendererReady) {
      _remoteRenderer.srcObject = null;
      _remoteRenderer.dispose();
    }
    super.dispose();
  }

  Future<void> _initTts() async {
    await _tts.setLanguage('tr-TR');
    await _tts.setSpeechRate(0.9);
    await _tts.setVolume(1.0);
    await _tts.setPitch(1.0);
    // Coordinate TTS with local STT to avoid the model hearing itself
    try {
      // When TTS starts, stop local listening (if any)
      // ignore: deprecated_member_use
      _tts.setStartHandler(() async {
        if (_listening) {
          await _speech.stop();
          if (mounted) setState(() => _listening = false);
        }
      });
      // When TTS completes, resume continuous listening if enabled and not using server speech
      // ignore: deprecated_member_use
      _tts.setCompletionHandler(() async {
        if (mounted && _continuousListen && !_serverSpeech && !_listening) {
          // ignore: discarded_futures
          _startListening();
        }
      });
    } catch (_) {
      // Some platforms may not support these handlers; ignore safely
    }
  }

  Future<void> _initPlayer() async {
    await _player.openPlayer();
    setState(() => _playerReady = true);
  }

  Future<void> _initStt() async {
    final available = await _speech.initialize(
      onStatus: _handleSttStatus,
      onError: _handleSttError,
    );
    if (!available) return;
    final locales = await _speech.locales();
    final systemLocale = await _speech.systemLocale();
    setState(() {
      _locales = locales;
      // If current _sttLocale not supported, fallback to system or en-US
      final supportsCurrent = locales.any((l) => l.localeId == _sttLocale);
      if (!supportsCurrent) {
        final sys = systemLocale?.localeId;
        if (sys != null && locales.any((l) => l.localeId == sys)) {
          _sttLocale = sys;
        } else if (locales.any((l) => l.localeId == 'en-US')) {
          _sttLocale = 'en-US';
        } else if (locales.isNotEmpty) {
          _sttLocale = locales.first.localeId;
        }
      }
    });
  }

  void _handleSttStatus(String s) {
    _sttStatus = s;
    if (s == 'done' || s == 'notListening') {
      _listening = false;
      // Auto-send partial if no final was sent (only non-continuous)
      if (!_continuousListen && !_sentFromThisListen) {
        final candidate = _partialText.trim();
        if (candidate.isNotEmpty) {
          _textCtrl.text = candidate;
          _sendText();
        }
      }
      // Auto-relisten when in continuous mode (independent of WS)
      if (_continuousListen) {
        if (mounted && !_listening) {
          // immediate restart
          // ignore: discarded_futures
          _startListening();
        }
      }
    }
    if (mounted) setState(() {});
  }

  void _handleSttError(dynamic e) {
    _sttStatus = 'error';
    if (mounted) setState(() {});
    final String msg = e?.toString() ?? 'unknown error';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('STT error: $msg')),
    );
  }

  Future<void> _loadPrefs() async {
    final sp = await SharedPreferences.getInstance();
    final savedBase = sp.getString('backend_base');
    if (savedBase != null && savedBase.isNotEmpty) {
      setState(() {
        _backendOverride = savedBase;
        _backendCtrl.text = savedBase;
      });
    }
    final cont = sp.getBool('stt_continuous');
    if (cont != null) {
      setState(() => _continuousListen = cont);
    }
  }

  Future<void> _savePrefs() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString('backend_base', _backendOverride ?? '');
    await sp.setBool('stt_continuous', _continuousListen);
  }

  void _addMessage(String role, String text) {
    setState(() {
      _messages.add(ChatMessage(role, text));
    });
    _scrollToBottom();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  // Apply a tiny fade-in/out at the edges of each PCM chunk to reduce clicks
  // Assumes little-endian signed 16-bit mono PCM.
  Uint8List _applyEdgeFade(Uint8List data, {int fadeSamples = 80}) {
    if (data.length < 4) return data; // too short
    final int totalSamples = data.length ~/ 2;
    if (totalSamples <= fadeSamples * 2) return data;
    // Work on a copy to avoid mutating the original buffer unexpectedly
    final bytes = Uint8List.fromList(data);
    // Fade-in
    for (int i = 0; i < fadeSamples; i++) {
      final int idx = i * 2;
      int s = (bytes[idx] | (bytes[idx + 1] << 8));
      if ((s & 0x8000) != 0) s -= 0x10000;
      final double gain = i / fadeSamples;
      int v = (s * gain).round();
      if (v < -32768) v = -32768; if (v > 32767) v = 32767;
      final int u = (v & 0xFFFF);
      bytes[idx] = (u & 0xFF);
      bytes[idx + 1] = ((u >> 8) & 0xFF);
    }
    // Fade-out
    for (int i = 0; i < fadeSamples; i++) {
      final int sampleIndex = totalSamples - 1 - i;
      final int idx = sampleIndex * 2;
      int s = (bytes[idx] | (bytes[idx + 1] << 8));
      if ((s & 0x8000) != 0) s -= 0x10000;
      final double gain = i / fadeSamples; // 0..1
      final double scale = 1.0 - gain;
      int v = (s * scale).round();
      if (v < -32768) v = -32768; if (v > 32767) v = 32767;
      final int u = (v & 0xFFFF);
      bytes[idx] = (u & 0xFF);
      bytes[idx + 1] = ((u >> 8) & 0xFF);
    }
    return bytes;
  }

  Future<void> checkHealth() async {
    setState(() => _loadingHealth = true);
    try {
      final uri = Uri.parse('$backendBase/health');
      final resp = await http.get(uri);
      if (resp.statusCode == 200) {
        _health = 'OK';
      } else {
        _health = 'ERROR ${resp.statusCode}';
      }
    } catch (e) {
      _health = 'ERROR: $e';
    } finally {
      setState(() => _loadingHealth = false);
    }
  }

  Future<void> startSession() async {
    if (_health != 'OK') {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Backend not reachable. Tap Check first.')),
      );
      return;
    }
    setState(() => _loadingSession = true);
    try {
      final uri = Uri.parse('$backendBase/session/start');
      final resp = await http.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'plan': 'free', 'mode': _selectedMode}),
      );
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body) as Map<String, dynamic>;
        setState(() {
          _sessionId = data['sessionId'] as String?;
          _wsUrl = data['wsUrl'] as String?;
        });
        // Auto-connect to WS after session starts (skip when WebRTC mode is ON)
        if (!_useWebRTC) {
          await _connectWebSocket();
        } else {
          _appendLog('Skip WS connect: WebRTC mode active');
        }
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Session started: ${_sessionId ?? '-'}')),
        );
      } else {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Start failed: ${resp.statusCode}')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Error: $e')),
      );
    } finally {
      setState(() => _loadingSession = false);
    }
  }

  String _buildWsUrl(String pathOrUrl) {
    if (pathOrUrl.startsWith('ws://') || pathOrUrl.startsWith('wss://')) {
      return pathOrUrl;
    }
    final base = backendBase.replaceFirst('http', 'ws');
    if (pathOrUrl.startsWith('/')) return '$base$pathOrUrl';
    return '$base/$pathOrUrl';
  }

  Future<void> _connectWebSocket() async {
    if (_useWebRTC) {
      _appendLog('WS connect blocked: WebRTC mode active');
      return;
    }
    final raw = _wsUrl;
    if (raw == null || raw.isEmpty) return;
    final url = _buildWsUrl(raw);
    // Close any previous channel
    await _channel?.sink.close();
    try {
      final ch = WebSocketChannel.connect(Uri.parse(url));
      setState(() {
        _channel = ch;
        _logs.clear();
        _logs.add('WS connecting to: $url');
        _connected = true;
      });
      // Start the player to receive audio stream from bot
      if (_playerReady) {
        // ignore: discarded_futures
        _player.startPlayerFromStream(
          codec: Codec.pcm16, // 24kHz, 16-bit PCM
          numChannels: 1,
          sampleRate: _playerSampleRate,
          // Larger buffer to reduce choppiness (increase from 16KB to 32KB)
          bufferSize: 32768,
          interleaved: false,
        );
        // Start periodic flush of jitter buffer at 20ms intervals
        _botAudioFlushTimer?.cancel();
        _botAudioFlushTimer = Timer.periodic(const Duration(milliseconds: 20), (_) {
          if (!_playerReady) return;
          final int frameBytes = (_playerSampleRate ~/ 50) * _pcmBytesPerSample; // 20ms at 16kHz = 640 bytes
          while (_botAudioBuffer.length >= frameBytes) {
            final chunk = Uint8List.sublistView(_botAudioBuffer, 0, frameBytes);
            // Shift buffer
            final remaining = Uint8List.sublistView(_botAudioBuffer, frameBytes);
            _botAudioBuffer = Uint8List.fromList(remaining);
            final processed = _applyEdgeFade(chunk, fadeSamples: 40); // 2.5ms fade
            _player.feedFromStream(processed);
          }
        });
      }
      int _audioBytesAccum = 0;
      DateTime _lastAudioLog = DateTime.now();
      ch.stream.listen((message) {
        // Differentiate between binary audio and text JSON
        if (message is String) {
          try {
            final obj = jsonDecode(message) as Map<String, dynamic>;
            final type = obj['type']?.toString() ?? '';

            switch (type) {
              case 'hello':
                _appendLog('HELLO session ${obj['sessionId']}');
                _addMessage('system', 'Connected (session ${obj['sessionId']})');
                break;
              case 'transcript':
                final text = obj['text']?.toString() ?? '';
                final isFinal = obj['final'] == true;
                if (isFinal) {
                  _addMessage('user', text);
                  _partialText = ''; // Clear partial text on final
                } else {
                  _partialText = text; // Update partial text
                }
                break;
              case 'error':
                _appendLog('ERROR ${obj['error']}');
                _addMessage('system', 'Error: ${obj['error']}');
                break;
              case 'bot_speaking':
                // Backend signali: bot yanıt üretimine başladı -> mic'i hemen durdur
                _appendLog('BOT speaking -> pause mic');
                _suppressMic = true;
                _botSilenceTimer?.cancel();
                // Give a bit more time before re-opening mic to avoid overlap
                _botSilenceTimer = Timer(const Duration(milliseconds: 1000), () {
                  _suppressMic = false;
                });
                if (_micSub != null) {
                  try {
                    _micSub?.cancel();
                    _micSub = null;
                    _recorder.stop();
                    _sendMic = false;
                    _silenceMs = 0;
                  } catch (_) {}
                }
                break;
              case 'audio_end':
                // Bot sesinin bittiğini sunucu bildirdi -> mic stream'i tekrar başlat (half‑duplex)
                _appendLog('BOT audio_end -> resume mic');
                if (_connected && _micSub == null) {
                  // ignore: discarded_futures
                  _startServerAudio();
                }
                break;
              default:
                _appendLog('EVENT ${obj['type']}: ${jsonEncode(obj)}');
                _addMessage('system', 'Event: ${obj['type']}');
            }
          } catch (e) {
            _appendLog('JSON parse error: $e');
          }
        } else if (message is List<int>) {
          // Binary data is incoming audio from the bot
          // Accumulate into jitter buffer to output at steady cadence
          final incoming = Uint8List.fromList(message);
          final combined = Uint8List(_botAudioBuffer.length + incoming.length);
          combined.setRange(0, _botAudioBuffer.length, _botAudioBuffer);
          combined.setRange(_botAudioBuffer.length, combined.length, incoming);
          _botAudioBuffer = combined;
          // While bot audio plays, temporarily suppress mic frames
          _suppressMic = true;
          _botSilenceTimer?.cancel();
          // Increase suppression window to avoid capturing tail of TTS
          _botSilenceTimer = Timer(const Duration(milliseconds: 1000), () {
            _suppressMic = false;
          });
          // Enter strict half-duplex: stop mic stream entirely during bot playback
          if (_micSub != null) {
            try {
              _micSub?.cancel();
              _micSub = null;
              _recorder.stop();
              _sendMic = false;
              _silenceMs = 0;
              _appendLog('Half-duplex: mic paused while bot speaks');
            } catch (_) {}
          }
          // Accumulate and occasionally log incoming audio size
          _audioBytesAccum += message.length;
          final now2 = DateTime.now();
          if (now2.difference(_lastAudioLog).inMilliseconds >= 1000) {
            _appendLog('BOT audio ~${(_audioBytesAccum/1024).toStringAsFixed(1)} KB/s');
            _audioBytesAccum = 0;
            _lastAudioLog = now2;
          }
        }
        // Throttle UI updates to at most every 100ms regardless of branch
        final now = DateTime.now();
        if (_lastUiUpdate == null || now.difference(_lastUiUpdate!).inMilliseconds >= 100) {
          _lastUiUpdate = now;
          if (mounted) setState(() {});
        }
      }, onDone: () {
        _appendLog('WS closed');
        if (_playerReady) {
          // ignore: discarded_futures
          _player.stopPlayer();
        }
        _botAudioFlushTimer?.cancel();
        _botAudioFlushTimer = null;
        _botAudioBuffer = Uint8List(0);
        _connected = false;
        _stopServerAudio();
        _scheduleWsRetry();
        setState(() {});
      }, onError: (e) {
        _appendLog('WS error: $e');
        if (_playerReady) {
          // ignore: discarded_futures
          _player.stopPlayer();
        }
        _botAudioFlushTimer?.cancel();
        _botAudioFlushTimer = null;
        _botAudioBuffer = Uint8List(0);
        _connected = false;
        _stopServerAudio();
        _scheduleWsRetry();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('WebSocket hatası: $e')),
          );
        }
        setState(() {});
      });
    } catch (e) {
      _appendLog('WS connect failed: $e');
      _scheduleWsRetry();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('WS bağlantı hatası: $e')),
        );
      }
      setState(() {});
    }
  }

  void _disconnectWebSocket() {
    try {
      _channel?.sink.close();
    } catch (_) {}
    _connected = false;
    // stop mic if streaming
    _stopServerAudio();
    setState(() {});
  }

  void _appendLog(String msg) {
    _logs.add('${DateTime.now().toIso8601String().substring(11,19)} | $msg');
  }

  Future<void> _ensureOpenDataChannel() async {
    if (_pc == null) return;
    if (_dc != null && _dc!.state == RTCDataChannelState.RTCDataChannelOpen) return;
    if (_dc == null) {
      // Create negotiated DataChannel with id=0 to match OpenAI Realtime expectations
      final init = RTCDataChannelInit()
        ..negotiated = true
        ..id = 0;
      _dc = await _pc!.createDataChannel('oai-events', init);
      _dc!.onMessage = (m) => _appendLog('DC msg: ${m.text}');
      _dc!.onDataChannelState = (s) {
        _appendLog('DC(state): $s');
        setState(() => _webrtcStatus = '${_webrtcStatus.split(' | ').first} | $s');
      };
    }
    // Wait up to 2 seconds for OPEN
    final start = DateTime.now();
    while (_dc!.state != RTCDataChannelState.RTCDataChannelOpen && DateTime.now().difference(start).inMilliseconds < 2000) {
      await Future.delayed(const Duration(milliseconds: 50));
    }
  }

  Future<void> _webrtcSendJson(Map<String, dynamic> obj) async {
    if (_pc == null) return;
    await _ensureOpenDataChannel();
    final ch = _dc;
    if (ch == null || ch.state != RTCDataChannelState.RTCDataChannelOpen) {
      _appendLog('DC not open; cannot send');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('DataChannel henüz açık değil')));
      }
      return;
    }
    try {
      ch.send(RTCDataChannelMessage(jsonEncode(obj)));
      _appendLog('DC send: ${jsonEncode(obj)}');
    } catch (e) {
      _appendLog('DC send error: $e');
    }
  }

  Future<void> _webrtcPrompt(String text) async {
    if (_pc == null) return;
    await _webrtcSendJson({
      'type': 'response.create',
      'response': {
        'modalities': ['audio','text'],
        'instructions': '$text\n\nLütfen kısa ve doğal Türkçe yanıt ver.',
      }
    });
  }

  Future<void> _startWebRTC() async {
    if (_pc != null) return;
    setState(() => _webrtcStatus = 'starting');
    try {
      // Ensure legacy PCM player is fully stopped to avoid audio routing conflicts
      if (_playerReady) {
        try { await _player.stopPlayer(); } catch (_) {}
      }
      // 1) Ephemeral token al
      final uri = Uri.parse('$backendBase/realtime/ephemeral');
      final resp = await http.post(uri, headers: {'Content-Type': 'application/json'});
      if (resp.statusCode != 200) {
        throw Exception('Ephemeral token failed: ${resp.statusCode} ${resp.body}');
      }
      final data = jsonDecode(resp.body) as Map<String, dynamic>;
      final token = (data['client_secret'] ?? '') as String;
      final model = (data['model'] ?? 'gpt-4o-realtime-preview') as String;
      if (token.isEmpty) throw Exception('Empty ephemeral token');

      // 2) WebRTC peer kur
      final pc = await createPeerConnection({
        'sdpSemantics': 'unified-plan',
        'iceServers': [
          {'urls': 'stun:stun.l.google.com:19302'},
        ]
      }, {
        'mandatory': {},
        'optional': [
          {'DtlsSrtpKeyAgreement': true},
        ]
      });
      // Diagnostics & media routing
      pc.onConnectionState = (s) => _appendLog('PC: $s');
      pc.onIceConnectionState = (s) => _appendLog('ICE: $s');
      pc.onIceGatheringState = (s) => _appendLog('ICE-Gather: $s');

      pc.onIceConnectionState = (state) {
        _appendLog('WebRTC ICE: $state');
        setState(() => _webrtcStatus = state.toString());
      };
      pc.onConnectionState = (state) {
        _appendLog('WebRTC PC: $state');
        setState(() => _webrtcStatus = '${state.toString()} | ${_dc?.state}');
      };
      pc.onDataChannel = (RTCDataChannel ch) {
        _appendLog('onDataChannel: ${ch.label}');
        _dc = ch;
        ch.onDataChannelState = (s) {
          _appendLog('DC(state): $s');
          setState(() => _webrtcStatus = '${_webrtcStatus.split(' | ').first} | $s');
        };
        ch.onMessage = (m) {
          _appendLog('DC msg: ${m.text}');
        };
        setState(() {});
      };
      pc.onTrack = (event) async {
        // Remote audio; route to speaker to ensure audibility on Android
        _appendLog('WebRTC onTrack: kind=${event.track.kind}');
        try {
          await Helper.setSpeakerphoneOn(true);
          event.track.enabled = true;
          for (final s in event.streams) {
            for (final t in s.getAudioTracks()) {
              t.enabled = true;
            }
          }
          // Attach first remote stream to renderer so Android actually plays audio
          if (event.streams.isNotEmpty && _rendererReady) {
            _remoteRenderer.srcObject = event.streams.first;
          }
        } catch (_) {}
      };

      // DataChannel (OpenAI expects negotiated dc with id=0 and label 'oai-events')
      final dc = await pc.createDataChannel('oai-events', RTCDataChannelInit()
        ..negotiated = true
        ..id = 0);
      dc.onMessage = (m) {
        _appendLog('DC msg: ${m.text}');
      };
      dc.onDataChannelState = (state) {
        _appendLog('DC state: $state');
        setState(() => _webrtcStatus = '${_webrtcStatus.split(' | ').first} | $state');
      };

      // 3) Geçici: recv-only test (mikrofonu göndermeden sadece uzak sesi al)
      // Not: Sorunu izole etmek için local track eklemeyi kapattık.
      // Remote sesin gelebilmesi için explicit recv-only transceiver ekleyelim.
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
      // Eğer bu testte onTrack düşerse, bir sonraki adımda sendrecv ile mikrofona geri döneceğiz.

      // 4) Offer oluştur ve OpenAI Realtime'a gönder (basitleştirilmiş)
      final offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      // Trickle ICE yerine full ICE SDP gönder: gathering COMPLETE olana kadar bekle
      await _waitForIceGatheringComplete(pc, timeoutMs: 3000);
      final local = await pc.getLocalDescription();
      final finalSdp = local?.sdp ?? offer.sdp;

      final sdpUri = Uri.parse('https://api.openai.com/v1/realtime?model=$model');
      final sdpResp = await http.post(
        sdpUri,
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/sdp',
          'Accept': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
        body: finalSdp,
      );
      if (sdpResp.statusCode < 200 || sdpResp.statusCode >= 300) {
        throw Exception('SDP exchange failed: ${sdpResp.statusCode} ${sdpResp.body}');
      }
      final answerSdp = sdpResp.body;
      final answer = RTCSessionDescription(answerSdp, 'answer');
      await pc.setRemoteDescription(answer);

      setState(() {
        _pc = pc;
        _dc = dc;
        _webrtcStatus = 'connected';
      });
      _appendLog('WebRTC connected via OpenAI Realtime');
      // Quick audio sanity check: ask the model to speak a short Turkish greeting
      // ignore: discarded_futures
      _webrtcPrompt('Merhaba de. Kısaca yanıt ver.');
    } catch (e) {
      _appendLog('WebRTC start failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('WebRTC başlatma hatası: $e')));
      }
      await _stopWebRTC();
    }
  }

  Future<void> _stopWebRTC() async {
    try {
      _webrtcStatus = 'stopping';
      final pc = _pc;
      final stream = _localStream;
      final dc = _dc;
      _dc = null;
      _pc = null;
      _localStream = null;
      if (dc != null) {
        await dc.close();
      }
      if (pc != null) {
        await pc.close();
      }
      if (stream != null) {
        for (var t in stream.getTracks()) {
          await t.stop();
        }
        await stream.dispose();
      }
      setState(() => _webrtcStatus = 'idle');
      _appendLog('WebRTC stopped');
    } catch (_) {}
  }

  Future<void> _startServerAudio() async {
    if (!_connected || _micSub != null) return;
    try {
      // Ensure mic permission
      final ok = await _ensureMicPermission();
      if (!ok) {
        _appendLog('Mic permission denied');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Mikrofon izni gerekli')),
          );
        }
        return;
      }
      // Notify server (optional framing)
      _channel?.sink.add(jsonEncode({
        'type': 'audio_start',
        'format': 'pcm16',
        'sampleRate': _micSampleRate,
        'channels': 1,
      }));
      final stream = await _recorder.startStream(
        RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: _micSampleRate,
          numChannels: 1,
        ),
      );
      _micSub = stream.listen((Uint8List data) {
        try {
          // Estimate frame duration (ms)
          final samples = data.length ~/ _pcmBytesPerSample;
          final frameMs = ((samples / _micSampleRate) * 1000).round();

          // Simple energy-based VAD
          int sumAbs = 0;
          for (int i = 0; i + 1 < data.length; i += 2) {
            final s = (data[i] | (data[i + 1] << 8));
            final signed = (s & 0x8000) != 0 ? s - 0x10000 : s;
            sumAbs += signed.abs();
          }
          final avgAbs = sumAbs ~/ (samples == 0 ? 1 : samples);
          final isSilent = avgAbs < _vadSilenceThreshold;

          // Transition: silence -> voice
          if (!_sendMic && !isSilent && !_suppressMic) {
            _sendMic = true;
            _silenceMs = 0;
            _channel?.sink.add(jsonEncode({ 'type': 'audio_start' }));
            _appendLog('VAD: voice start (avg=$avgAbs)');
          }

          // While speaking, forward frames (unless suppressed)
          if (_sendMic && !_suppressMic) {
            _channel?.sink.add(data);
          }

          if (_sendMic) {
            if (isSilent) {
              _silenceMs += frameMs;
              if (_silenceMs >= _silenceStopMs) {
                // Transition: voice -> silence (commit)
                _sendMic = false;
                _silenceMs = 0;
                _channel?.sink.add(jsonEncode({ 'type': 'audio_stop' }));
                _appendLog('VAD: voice stop (commit)');
              }
            } else {
              _silenceMs = 0;
            }
          }
        } catch (_) {}
      });
      _appendLog('Mic streaming started');
    } catch (e) {
      _appendLog('Mic start failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Mic start failed: $e')),
        );
      }
    }
  }

  Future<bool> _ensureMicPermission() async {
    var status = await Permission.microphone.status;
    if (status.isGranted) return true;
    status = await Permission.microphone.request();
    return status.isGranted;
  }

  Future<void> _stopServerAudio() async {
    try {
      _micSub?.cancel();
      _micSub = null;
      await _recorder.stop();
      // Notify server end (optional)
      _channel?.sink.add(jsonEncode({'type': 'audio_stop'}));
      _appendLog('Mic streaming stopped');
    } catch (_) {}
  }

  void _sendText() {
    final ch = _channel;
    final text = _textCtrl.text.trim();
    if (ch == null || text.isEmpty) return;
    ch.sink.add(jsonEncode({'type': 'text', 'text': text}));
    _appendLog('YOU: $text');
    _addMessage('user', text);
    _textCtrl.clear();
    setState(() {});
  }

  Future<void> _startListening() async {
    // Önceki oturumun meşgul kalmasını önlemek için mevcut dinlemeyi iptal et
    if (_speech.isListening) {
      await _speech.cancel();
    }
    if (_listening) return;
    // Stop TTS to avoid audio focus conflict
    await _tts.stop();
    if (!_speech.isAvailable) {
      await _initStt();
      if (!_speech.isAvailable) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Speech recognition not available or permission denied')),
          );
        }
        return;
      }
    }
    _partialText = '';
    _sentFromThisListen = false;
    _commitTimer?.cancel();
    _pendingFinal = null;
    setState(() => _listening = true);

    // Start watchdog when continuous mode is on (independent of WS)
    if (_continuousListen) {
      _ensureListeningTimer?.cancel();
      _ensureListeningTimer = Timer.periodic(const Duration(milliseconds: 200), (_) {
        if (!mounted) return;
        if (_continuousListen && !_listening) {
          // ignore: discarded_futures
          _startListening();
        }
        if (!_continuousListen) {
          _ensureListeningTimer?.cancel();
        }
      });
    }
    await _speech.listen(
      localeId: _sttLocale,
      onResult: (r) {
        _partialText = r.recognizedWords;
        if (r.finalResult) {
          final text = r.recognizedWords.trim();
          if (text.isNotEmpty) {
            if (_continuousListen) {
              // Debounce commit in continuous mode: wait for a longer pause
              if (_pendingFinal == null || _pendingFinal!.isEmpty) {
                _pendingFinal = text;
              } else {
                // accumulate consecutive finals while user continues
                _pendingFinal = (_pendingFinal! + ' ' + text).trim();
              }
              _commitTimer?.cancel();
              _commitTimer = Timer(const Duration(milliseconds: 4000), () {
                if (_pendingFinal != null && _pendingFinal!.isNotEmpty) {
                  _textCtrl.text = _pendingFinal!;
                  _sendText();
                  _sentFromThisListen = true;
                  _pendingFinal = null;
                }
              });
            } else {
              _textCtrl.text = text;
              _sendText();
              _sentFromThisListen = true;
            }
          } else {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Ses algılandı ama metne dönüştürülemedi.')),
            );
          }
        } else {
          // Any new partial means user resumed talking -> cancel pending commit
          if (_continuousListen) {
            _commitTimer?.cancel();
          }
        }
        setState(() {});
      },
      listenMode: stt.ListenMode.dictation,
      cancelOnError: false,
      partialResults: true,
      onSoundLevelChange: (level) {
        _soundLevel = level;
        setState(() {});
      },
      // Keep mic open longer across natural pauses
      pauseFor: const Duration(seconds: 60),
      // Much longer session in continuous mode; watchdog + auto-relisten keep it alive
      listenFor: _continuousListen ? const Duration(minutes: 30) : const Duration(seconds: 20),
    );
  }

  Future<void> _stopListening() async {
    if (!_listening) return;
    await _speech.stop();
    setState(() => _listening = false);
  }

  void _scheduleWsRetry() {
    if (_wsUrl == null) return;
    _retryTimer?.cancel();
    final delay = Duration(seconds: _retryAttempt == 0 ? 1 : (_retryAttempt > 5 ? 30 : (1 << _retryAttempt))); // 1,2,4,8,16,30...
    _retryAttempt++;
    _appendLog('Retrying WS in ${delay.inSeconds}s...');
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('WebSocket kapandı. ${delay.inSeconds}s içinde yeniden denenecek.')),
      );
    }
    _retryTimer = Timer(delay, () {
      if (_wsUrl != null && !_connected) {
        // ignore: discarded_futures
        _connectWebSocket();
      }
    });
  }

  void _sendPing() {
    final ch = _channel;
    if (ch == null) return;
    ch.sink.add(jsonEncode({'type': 'ping'}));
    _appendLog('PING');
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: const Text('Lingoflow'),
      ),
      body: SingleChildScrollView(
        physics: const BouncingScrollPhysics(),
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Backend: '+backendBase, style: const TextStyle(fontSize: 12, color: Colors.black54)),
              const SizedBox(height: 8),
              // Responsive header: use Wrap to avoid horizontal overflow on small widths
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 8,
                runSpacing: 8,
                children: [
                  const Text('Backend health:'),
                  Text(
                    _health,
                    style: TextStyle(
                      color: _health == 'OK' ? Colors.green : Colors.red,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  ElevatedButton(
                    onPressed: _loadingHealth ? null : checkHealth,
                    child: _loadingHealth
                        ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Check'),
                  ),
                  Chip(
                    avatar: Icon(Icons.circle, size: 12, color: _connected ? Colors.green : Colors.red),
                    label: Text(_connected ? 'Connected' : 'Disconnected'),
                  ),
                ],
              ),
            const SizedBox(height: 16),
            const Text('Mode'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                for (final m in ['Simulation', 'Micro-correction', 'Free Talk'])
                  ChoiceChip(
                    label: Text(m),
                    selected: _selectedMode == m,
                    onSelected: (v) {
                      if (v) setState(() => _selectedMode = m);
                    },
                  ),
              ],
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _loadingSession ? null : startSession,
              icon: _loadingSession
                  ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.play_arrow),
              label: const Text('Start Session'),
            ),
            const SizedBox(height: 16),
            Text('Session: ${_sessionId ?? '-'}'),
            Text('WS URL: ${_wsUrl ?? '-'}'),
            const SizedBox(height: 16),
            Row(
              children: [
                if (!_connected)
                  ElevatedButton(
                    onPressed: _wsUrl == null ? null : _connectWebSocket,
                    child: const Text('Connect WS'),
                  )
                else
                  ElevatedButton(
                    onPressed: _disconnectWebSocket,
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.red.shade400),
                    child: const Text('Disconnect'),
                  ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: _channel == null ? null : _sendPing,
                  child: const Text('Ping'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            // Settings: backend override and listening mode (hidden when connected)
            if (!_connected) Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _backendCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Backend Base (override)',
                      hintText: 'http://192.168.1.10:8080',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: () async {
                    setState(() => _backendOverride = _backendCtrl.text.trim());
                    await _savePrefs();
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Backend base saved')));
                  },
                  child: const Text('Save'),
                ),
              ],
            ),
            if (!_connected) const SizedBox(height: 8),
            // Server STT/TTS toggle
            Row(
              children: [
                const Text('Server STT/TTS'),
                Switch(
                  value: _serverSpeech,
                  onChanged: (v) async {
                    setState(() => _serverSpeech = v);
                    if (_serverSpeech) {
                      // stop local STT if running
                      if (_listening) {
                        // ignore: discarded_futures
                        _stopListening();
                      }
                      if (_connected) {
                        // ignore: discarded_futures
                        _startServerAudio();
                      }
                    } else {
                      _stopServerAudio();
                    }
                  },
                ),
                if (_serverSpeech)
                  Chip(label: const Text('Streaming PCM'), avatar: const Icon(Icons.surround_sound))
              ],
            ),
            const SizedBox(height: 8),
            // WebRTC (OpenAI) controls
            Row(
              children: [
                const Text('Use WebRTC (OpenAI)'),
                Switch(
                  value: _useWebRTC,
                  onChanged: (v) async {
                    setState(() => _useWebRTC = v);
                    if (v) {
                      // Disable WS/PCM pipeline while WebRTC is active
                      if (_connected) {
                        _disconnectWebSocket();
                      }
                      // Ensure legacy PCM player is stopped
                      if (_playerReady) {
                        try { await _player.stopPlayer(); } catch (_) {}
                      }
                    } else {
                      // Stop WebRTC when toggled off
                      // ignore: discarded_futures
                      _stopWebRTC();
                    }
                  },
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: !_useWebRTC || _pc != null ? null : _startWebRTC,
                  child: const Text('Start WebRTC'),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: !_useWebRTC || _pc == null ? null : _stopWebRTC,
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.red.shade400),
                  child: const Text('Stop WebRTC'),
                ),
              ],
            ),
            if (_useWebRTC)
              Padding(
                padding: const EdgeInsets.only(top: 4.0),
                child: Text('WebRTC: $_webrtcStatus'),
              ),
            if (_useWebRTC)
              Row(
                children: [
                  ElevatedButton(
                    onPressed: _pc != null ? () => _webrtcPrompt('Merhaba, orada mısın?') : null,
                    child: const Text('Test: Selam de'),
                  ),
                ],
              ),
            Row(
              children: [
                const Text('Continuous'),
                Switch(
                  value: _continuousListen,
                  onChanged: (v) async {
                    setState(() => _continuousListen = v);
                    await _savePrefs();
                  },
                ),
                const Text('Push-to-Talk'),
              ],
            ),
            const SizedBox(height: 8),
            if (_connected && !_serverSpeech) Row(
              children: [
                Chip(
                  label: Text('STT: $_sttStatus  lvl: ${_soundLevel.toStringAsFixed(1)}'),
                  avatar: Icon(_listening ? Icons.mic : Icons.mic_none, color: _listening ? Colors.red : Colors.grey),
                ),
                const SizedBox(width: 8),
                if (_partialText.isNotEmpty)
                  Expanded(
                    child: Text('… $_partialText', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontStyle: FontStyle.italic)),
                  ),
              ],
            ),
            if (_connected && _serverSpeech && _partialText.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8.0),
                child: Text('$_partialText', style: const TextStyle(fontStyle: FontStyle.italic, color: Colors.grey)),
              ),
            if (_connected) const SizedBox(height: 8),
            Row(
              children: [
                if (!_serverSpeech && _continuousListen)
                  ElevatedButton.icon(
                    onPressed: _connected ? (_listening ? _stopListening : _startListening) : null,
                    icon: Icon(_listening ? Icons.stop_circle : Icons.mic),
                    label: Text(_listening ? 'Stop Listening' : 'Start Listening'),
                  )
                else if (!_serverSpeech)
                  Expanded(
                    child: GestureDetector(
                      onTapDown: (_) {
                        if (_connected && !_listening) {
                          // ignore: discarded_futures
                          _startListening();
                        }
                      },
                      onTapUp: (_) {
                        if (_connected && _listening) {
                          // ignore: discarded_futures
                          _stopListening();
                        }
                      },
                      onTapCancel: () {
                        if (_connected && _listening) {
                          // ignore: discarded_futures
                          _stopListening();
                        }
                      },
                      child: ElevatedButton.icon(
                        onPressed: null,
                        icon: const Icon(Icons.mic),
                        label: const Text('Hold to Talk'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: _listening ? Colors.red.shade400 : null,
                        ),
                      ),
                    ),
                  ),
                if (_serverSpeech)
                  ElevatedButton.icon(
                    onPressed: _connected
                        ? () {
                            if (_micSub == null) {
                              // ignore: discarded_futures
                              _startServerAudio();
                            } else {
                              _stopServerAudio();
                            }
                            setState(() {});
                          }
                        : null,
                    icon: Icon(_micSub == null ? Icons.surround_sound : Icons.stop_circle),
                    label: Text(_micSub == null ? 'Start Streaming' : 'Stop Streaming'),
                  ),
                const SizedBox(width: 8),
                DropdownButton<String>(
                  value: _sttLocale,
                  items: (_locales.isEmpty
                          ? const <DropdownMenuItem<String>>[
                              DropdownMenuItem(value: 'tr-TR', child: Text('tr-TR')),
                              DropdownMenuItem(value: 'en-US', child: Text('en-US')),
                            ]
                          : _locales
                              .map((l) => DropdownMenuItem(value: l.localeId, child: Text(l.localeId)))
                              .toList()),
                  onChanged: (v) async {
                    if (v == null) return;
                    setState(() => _sttLocale = v);
                    // TTS dilini de eşitleyelim
                    await _tts.setLanguage(v);
                  },
                ),
              ],
            ),
            const SizedBox(height: 8),
            // Enlarge messages area responsively (~60% of screen height)
            SizedBox(
              height: MediaQuery.of(context).size.height * 0.6,
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.black12),
                ),
                child: ListView.builder(
                  controller: _scrollCtrl,
                  physics: const BouncingScrollPhysics(),
                  itemCount: _messages.length,
                  itemBuilder: (ctx, i) {
                    final m = _messages[i];
                    final isUser = m.role == 'user';
                    final isBot = m.role == 'bot';
                    final align = isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start;
                    final bubbleColor = isUser ? Colors.indigo.shade100 : (isBot ? Colors.grey.shade200 : Colors.grey.shade100);
                    return Column(
                      crossAxisAlignment: align,
                      children: [
                        Container(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                          decoration: BoxDecoration(
                            color: bubbleColor,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(m.text, style: const TextStyle(fontSize: 17, height: 1.35)),
                        ),
                      ],
                    );
                  },
                ),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _textCtrl,
                    onSubmitted: (_) => _sendText(),
                    minLines: 3,
                    maxLines: 5,
                    textAlignVertical: TextAlignVertical.top,
                    style: const TextStyle(fontSize: 16),
                    decoration: const InputDecoration(
                      hintText: 'Type a message...',
                      border: OutlineInputBorder(),
                      contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: _channel == null ? null : _sendText,
                  child: const Text('Send'),
                ),
              ],
            ),
            // Removed Spacer to allow the messages list to occupy more vertical space
            const Text(
              'Note: On Android emulator/device, backend must be reachable. Use your PC\'s IP instead of localhost if needed.',
              style: TextStyle(fontSize: 12, color: Colors.black54),
            ),
          ],
        ),
      ),
    ),
  );
  }
}

package xyz.zihan.aloai

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.ImageView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "AloAI"
        const val NOTIFICATION_CHANNEL_ID = "alora_general"
        const val PRIMARY_ORIGIN = "https://alora.zdots.net"
        const val SECONDARY_ORIGIN = "https://alora.zihan.xyz"
        const val RENDER_ORIGIN = "https://alora-backend-emw3.onrender.com"
        const val APP_URL = "$PRIMARY_ORIGIN/"
        const val AUTH_URL = "$PRIMARY_ORIGIN/login.html"
        private val DOMAIN_FAILOVER_CHAIN = listOf(
            PRIMARY_ORIGIN,
            SECONDARY_ORIGIN,
            RENDER_ORIGIN
        )
        private const val EDGE_LOAD_TIMEOUT_MS = 7000L
        private const val RENDER_LOAD_TIMEOUT_MS = 55000L
        private const val BACK_PRESS_INTERVAL = 2000L

        private const val LIVE_WWW_DIR_NAME = "live_www"
        private const val LIVE_WWW_PREFS = "AloLiveWwwPrefs"
        private const val KEY_LIVE_VERSION_CODE = "cached_version_code"
        private const val VERSION_MARKER_PREFIX = ".ver_"
        private const val LIVE_SYNC_INTERVAL_MS = 5 * 60 * 1000L
        private const val COLD_LAUNCH_APPLY_WINDOW_MS = 3000L
        private val LIVE_HTML_PAGES = listOf(
            "index.html",
            "login.html",
            "plans.html",
            "account.html",
            "checkout.html",
            "profile.html",
            "security.html",
            "personalization.html",
            "help.html",
            "redeem.html",
            "download.html",
            "404.html"
        )
        private val LIVE_HTML_PAGE_SET = LIVE_HTML_PAGES.toSet()
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var launchVeil: View
    private var ivLaunchLogo: ImageView? = null
    private lateinit var offlineView: View
    private var isLaunchVeilDismissing = false
    private var hasLoadedPageSuccessfully = false
    private var activeBaseOrigin: String = PRIMARY_ORIGIN
    private var currentLoadHadMainFrameError = false
    private val attemptedOriginsInLoad = mutableSetOf<Int>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingLoadTimeoutRunnable: Runnable? = null

    private val liveWwwDir: File by lazy { File(filesDir, LIVE_WWW_DIR_NAME) }
    private val liveSyncExecutor = Executors.newSingleThreadExecutor()
    private val isLiveSyncRunning = AtomicBoolean(false)
    @Volatile private var lastLiveSyncElapsedMs = 0L
    @Volatile private var hasSyncedOnLaunch = false
    @Volatile private var hasInitialPaintCommitted = false
    @Volatile private var hasPendingIndexUpdate = false
    private var appLaunchElapsedMs = 0L
    private var shouldClearWebViewCacheOnVersionChange = false
    private val liveSyncHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var webAppInterface: WebAppInterface? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private var lastBackPressTime = 0L

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult

        var results: Array<Uri>? = null
        if (result.resultCode == RESULT_OK) {
            val data = result.data
            when {
                data?.data != null -> {
                    results = arrayOf(data.data!!)
                }
                data?.clipData != null -> {
                    val clipData = data.clipData!!
                    results = Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
                }
                cameraPhotoUri != null -> {
                    results = arrayOf(cameraPhotoUri!!)
                }
            }
        }

        callback.onReceiveValue(results)
        filePathCallback = null
        cameraPhotoUri = null
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingPermissionRequest ?: return@registerForActivityResult

        val grantedResources = request.resources.filter { res ->
            when (res) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                else -> false
            }
        }

        if (grantedResources.isNotEmpty()) {
            request.grant(grantedResources.toTypedArray())
        } else {
            request.deny()
        }
        pendingPermissionRequest = null
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            webView.post {
                webView.evaluateJavascript("if (typeof syncNotificationUI === 'function') syncNotificationUI();", null)
            }
        }
    }

    fun requestPostNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        try {
            val intent = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
            }
            startActivity(intent)
        } catch (_: Exception) {}
    }

    private var pendingSpeechLang: String? = null
    private var pendingCaptureMode: String? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var isSpeechListening = false
    private var customAudioRecord: AudioRecord? = null
    private var customAudioThread: Thread? = null
    @Volatile private var isCustomAudioRecording = false
    @Volatile private var forceFinishCustomAudio = false

    private val speechPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val lang = pendingSpeechLang
        val capMode = pendingCaptureMode
        pendingSpeechLang = null
        pendingCaptureMode = null
        if (granted) {
            if (capMode != null) {
                launchCustomAudioRecord(capMode)
            } else {
                launchNativeSpeechRecognizer(lang)
            }
        } else {
            webView.post {
                webView.evaluateJavascript("if (typeof window.onNativeSpeechError === 'function') window.onNativeSpeechError('Microphone permission denied.'); if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
            }
        }
    }

    private fun destroySpeechRecognizer() {
        try {
            speechRecognizer?.cancel()
            speechRecognizer?.destroy()
        } catch (_: Exception) {}
        speechRecognizer = null
        isSpeechListening = false
    }

    private fun buildPcm16WavBytes(pcmData: ByteArray, sampleRate: Int = 16000): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + pcmData.size)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)
        header.putShort(1) // PCM
        header.putShort(1) // Mono
        header.putInt(sampleRate)
        header.putInt(sampleRate * 2)
        header.putShort(2)
        header.putShort(16)
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(pcmData.size)
        val out = ByteArray(44 + pcmData.size)
        System.arraycopy(header.array(), 0, out, 0, 44)
        System.arraycopy(pcmData, 0, out, 44, pcmData.size)
        return out
    }

    @SuppressLint("MissingPermission")
    private fun launchCustomAudioRecord(mode: String) {
        stopCustomAudioInternal(deliverCapture = false)
        destroySpeechRecognizer()

        val sampleRate = 16000
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            webView.post {
                webView.evaluateJavascript("if (typeof window.onNativeSpeechError === 'function') window.onNativeSpeechError('Audio capture unavailable.'); if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
            }
            return
        }
        val bufSize = maxOf(minBuf * 2, 8192)
        var recorder: AudioRecord? = null
        try {
            recorder = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                recorder = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize
                )
            }
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                webView.post {
                    webView.evaluateJavascript("if (typeof window.onNativeSpeechError === 'function') window.onNativeSpeechError('Microphone busy.'); if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
                }
                return
            }
        } catch (_: Exception) {
            try { recorder?.release() } catch (_: Exception) {}
            webView.post {
                webView.evaluateJavascript("if (typeof window.onNativeSpeechError === 'function') window.onNativeSpeechError('Microphone error.'); if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
            }
            return
        }

        customAudioRecord = recorder
        isCustomAudioRecording = true
        forceFinishCustomAudio = false

        webView.post {
            webView.evaluateJavascript("if (typeof window.onNativeSpeechStart === 'function') window.onNativeSpeechStart();", null)
        }

        customAudioThread = Thread({
            val shortBuf = ShortArray(1024)
            val preRollChunks = ArrayDeque<ByteArray>()
            val capturedStream = ByteArrayOutputStream()
            var speechDetected = false
            var speechConfirmFrames = 0
            var ambientAccum = 0.0
            var ambientFrames = 0
            var ambientRms = 80.0
            val startedMs = android.os.SystemClock.elapsedRealtime()
            var lastVoiceMs = startedMs
            var lastVolPushMs = 0L

            try {
                recorder.startRecording()
                while (isCustomAudioRecording) {
                    val readCount = recorder.read(shortBuf, 0, shortBuf.size)
                    if (readCount <= 0) continue

                    var sumSq = 0.0
                    val byteChunk = ByteArray(readCount * 2)
                    var bi = 0
                    for (i in 0 until readCount) {
                        val s = shortBuf[i].toInt()
                        sumSq += (s * s).toDouble()
                        byteChunk[bi++] = (s and 0xFF).toByte()
                        byteChunk[bi++] = ((s shr 8) and 0xFF).toByte()
                    }
                    val rms = sqrt(sumSq / readCount)
                    val now = android.os.SystemClock.elapsedRealtime()

                    if (!speechDetected && ambientFrames < 5) {
                        ambientAccum += rms
                        ambientFrames++
                        ambientRms = ambientAccum / ambientFrames
                    }
                    val voiceThresh = maxOf(110.0, ambientRms * 2.2).coerceIn(110.0, 420.0)

                    if (now - lastVolPushMs >= 55L) {
                        lastVolPushMs = now
                        val norm = ((rms - 80.0) / 3000.0).toFloat().coerceIn(0f, 1f)
                        webView.post {
                            if (isCustomAudioRecording) {
                                webView.evaluateJavascript("if (typeof window.onNativeSpeechVolume === 'function') window.onNativeSpeechVolume($norm);", null)
                            }
                        }
                    }

                    if (rms > voiceThresh) {
                        speechConfirmFrames++
                        if (speechConfirmFrames >= 2) {
                            if (!speechDetected) {
                                speechDetected = true
                                while (preRollChunks.isNotEmpty()) {
                                    capturedStream.write(preRollChunks.removeFirst())
                                }
                            }
                            lastVoiceMs = now
                        }
                    } else {
                        speechConfirmFrames = 0
                    }

                    if (speechDetected) {
                        capturedStream.write(byteChunk)
                        val silenceElapsed = now - lastVoiceMs
                        val totalElapsed = now - startedMs
                        if (forceFinishCustomAudio || silenceElapsed >= 1350L || totalElapsed >= 22000L) {
                            break
                        }
                    } else {
                        preRollChunks.addLast(byteChunk)
                        while (preRollChunks.size > 6) preRollChunks.removeFirst()
                        if (forceFinishCustomAudio || (now - startedMs) >= 8500L) {
                            break
                        }
                    }
                }
            } catch (_: Exception) {
            } finally {
                val wasActive = isCustomAudioRecording || forceFinishCustomAudio
                isCustomAudioRecording = false
                forceFinishCustomAudio = false
                try { recorder.stop() } catch (_: Exception) {}
                try { recorder.release() } catch (_: Exception) {}
                if (customAudioRecord === recorder) customAudioRecord = null

                if (wasActive) {
                    val pcmBytes = capturedStream.toByteArray()
                    if (speechDetected && pcmBytes.size >= 3200) {
                        val wavBytes = buildPcm16WavBytes(pcmBytes, sampleRate)
                        val b64 = Base64.encodeToString(wavBytes, Base64.NO_WRAP)
                        val qB64 = JSONObject.quote(b64)
                        val qMode = JSONObject.quote(mode)
                        webView.post {
                            webView.evaluateJavascript("if (typeof window.onNativeAudioCaptured === 'function') window.onNativeAudioCaptured($qB64, $qMode);", null)
                        }
                    } else {
                        webView.post {
                            webView.evaluateJavascript("if (typeof window.onNativeAudioSilence === 'function') window.onNativeAudioSilence(); if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
                        }
                    }
                }
            }
        }, "AloraCustomAudioThread").also { it.start() }
    }

    private fun stopCustomAudioInternal(deliverCapture: Boolean) {
        if (!isCustomAudioRecording) return
        if (deliverCapture) {
            forceFinishCustomAudio = true
        } else {
            isCustomAudioRecording = false
            forceFinishCustomAudio = false
            try { customAudioRecord?.stop() } catch (_: Exception) {}
            try { customAudioRecord?.release() } catch (_: Exception) {}
            customAudioRecord = null
        }
    }

    fun startCustomAudioCapture(mode: String?) {
        runOnUiThread {
            val cleanMode = mode?.trim()?.takeIf { it.isNotEmpty() } ?: "live"
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingCaptureMode = cleanMode
                pendingSpeechLang = null
                speechPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                return@runOnUiThread
            }
            launchCustomAudioRecord(cleanMode)
        }
    }

    fun stopCustomAudioCapture(deliver: Boolean = false) {
        runOnUiThread {
            stopCustomAudioInternal(deliverCapture = deliver)
        }
    }

    private fun launchNativeSpeechRecognizer(langTag: String?, simpleFallback: Boolean = false) {
        runOnUiThread {
            val rawTag = langTag?.trim() ?: ""
            val isAuto = rawTag.isEmpty() || rawTag.equals("auto", ignoreCase = true)
            val cleanLang = when {
                simpleFallback -> if (isAuto) Locale.getDefault().toLanguageTag().ifBlank { "en-US" } else rawTag
                isAuto -> "bn-BD"
                else -> rawTag
            }
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, cleanLang)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, cleanLang)
                if (!simpleFallback) {
                    putExtra("android.speech.extra.EXTRA_ADDITIONAL_LANGUAGES", arrayOf("bn-BD", "en-US"))
                    if (isAuto && Build.VERSION.SDK_INT >= 33) {
                        putExtra("android.speech.extra.ENABLE_LANGUAGE_DETECTION", true)
                        putStringArrayListExtra(
                            "android.speech.extra.LANGUAGE_DETECTION_ALLOWED_LANGUAGES",
                            arrayListOf("bn-BD", "en-US")
                        )
                    }
                }
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2400L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 700L)
            }

            if (SpeechRecognizer.isRecognitionAvailable(this)) {
                try {
                    destroySpeechRecognizer()
                    val sr = SpeechRecognizer.createSpeechRecognizer(this)
                    speechRecognizer = sr
                    sr.setRecognitionListener(object : RecognitionListener {
                        private var lastRmsPushMs = 0L
                        override fun onReadyForSpeech(params: Bundle?) {
                            isSpeechListening = true
                            webView.evaluateJavascript("if (typeof window.onNativeSpeechStart === 'function') window.onNativeSpeechStart();", null)
                        }
                        override fun onBeginningOfSpeech() {}
                        override fun onRmsChanged(rmsdB: Float) {
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - lastRmsPushMs < 55L) return
                            lastRmsPushMs = now
                            val clamped = ((rmsdB - 1.5f) / 10.5f).coerceIn(0f, 1f)
                            webView.evaluateJavascript("if (typeof window.onNativeSpeechVolume === 'function') window.onNativeSpeechVolume($clamped);", null)
                        }
                        override fun onBufferReceived(buffer: ByteArray?) {}
                        override fun onEndOfSpeech() {
                            isSpeechListening = false
                        }
                        override fun onError(error: Int) {
                            isSpeechListening = false
                            destroySpeechRecognizer()
                            if (!simpleFallback && (error == 12 || error == 13 || error == 14 || error == SpeechRecognizer.ERROR_SERVER || error == SpeechRecognizer.ERROR_AUDIO)) {
                                // Device speech engine may reject multi-language detection extras -> retry cleanly with standard locale
                                launchNativeSpeechRecognizer(langTag, simpleFallback = true)
                                return
                            }
                            if (error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == 12 || error == 13 || error == 14 || error == SpeechRecognizer.ERROR_AUDIO) {
                                // Never open Google UI popup; fall back seamlessly to custom AudioRecord capture
                                launchCustomAudioRecord("live")
                                return
                            }
                            val errMsg = when (error) {
                                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission required."
                                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network needed for speech recognition."
                                else -> null
                            }
                            if (errMsg != null) {
                                val quoted = JSONObject.quote(errMsg)
                                webView.evaluateJavascript("if (typeof window.onNativeSpeechError === 'function') window.onNativeSpeechError($quoted);", null)
                            } else {
                                webView.evaluateJavascript("if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
                            }
                        }
                        override fun onResults(results: Bundle?) {
                            isSpeechListening = false
                            val spoken = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
                            if (!spoken.isNullOrEmpty()) {
                                val quoted = JSONObject.quote(spoken)
                                webView.evaluateJavascript("if (typeof window.onNativeSpeechResult === 'function') window.onNativeSpeechResult($quoted);", null)
                            } else {
                                webView.evaluateJavascript("if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
                            }
                            destroySpeechRecognizer()
                        }
                        override fun onPartialResults(partialResults: Bundle?) {
                            val partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
                            if (!partial.isNullOrEmpty()) {
                                val quoted = JSONObject.quote(partial)
                                webView.evaluateJavascript("if (typeof window.onNativeSpeechPartial === 'function') window.onNativeSpeechPartial($quoted);", null)
                            }
                        }
                        override fun onEvent(eventType: Int, params: Bundle?) {}
                    })
                    sr.startListening(intent)
                    return@runOnUiThread
                } catch (_: Exception) {
                    destroySpeechRecognizer()
                }
            }

            // Custom in-app PCM AudioRecord capture — NEVER opens external Google RecognizerIntent popup!
            launchCustomAudioRecord("dictation")
        }
    }

    fun startNativeSpeechInput(langTag: String?) {
        runOnUiThread {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingSpeechLang = langTag
                pendingCaptureMode = null
                speechPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                return@runOnUiThread
            }
            launchNativeSpeechRecognizer(langTag)
        }
    }

    fun stopNativeSpeechInput() {
        runOnUiThread {
            try {
                if (isCustomAudioRecording) {
                    stopCustomAudioInternal(deliverCapture = true)
                    return@runOnUiThread
                }
                if (isSpeechListening) {
                    speechRecognizer?.stopListening()
                }
                destroySpeechRecognizer()
                webView.evaluateJavascript("if (typeof window.onNativeSpeechEnd === 'function') window.onNativeSpeechEnd();", null)
            } catch (_: Exception) {}
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Alora Notifications",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Updates, announcements, and reply alerts from Alora"
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            nm?.createNotificationChannel(channel)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appLaunchElapsedMs = SystemClock.elapsedRealtime()
        createNotificationChannel()
        ensureLiveWwwCacheReady()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        )
        enableHighRefreshRate()
        setContentView(R.layout.activity_main)
        initViews()
        val isSysDark = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        applySystemBarsTheme(!isSysDark, if (isSysDark) "#000000" else "#FFFFFF")

        setupEdgeToEdgeInsets()
        setupWebView()
        if (shouldClearWebViewCacheOnVersionChange) {
            shouldClearWebViewCacheOnVersionChange = false
            try { webView.clearCache(true) } catch (_: Exception) {}
        }
        setupSwipeRefresh()
        setupBackNavigation()

        webView.settings.cacheMode = if (isNetworkAvailable()) {
            WebSettings.LOAD_DEFAULT
        } else {
            WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        val deepLink = extractTrustedDeepLink(intent)
        val initialUrl = if (!deepLink.isNullOrBlank()) {
            hostIndexForUrl(deepLink).takeIf { it >= 0 }?.let { activeBaseOrigin = DOMAIN_FAILOVER_CHAIN[it] }
            deepLink
        } else {
            "$activeBaseOrigin/"
        }
        attemptedOriginsInLoad.clear()
        webView.loadUrl(initialUrl)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val deepLink = extractTrustedDeepLink(intent)
        if (!deepLink.isNullOrBlank()) {
            attemptedOriginsInLoad.clear()
            hostIndexForUrl(deepLink).takeIf { it >= 0 }?.let { activeBaseOrigin = DOMAIN_FAILOVER_CHAIN[it] }
            webView.loadUrl(deepLink)
        }
    }

    private fun hostIndexForUrl(url: String?): Int {
        if (url.isNullOrBlank()) return -1
        val host = try {
            Uri.parse(url).host?.lowercase(Locale.US)
        } catch (_: Exception) {
            null
        } ?: return -1
        return when {
            host == "alora.zdots.net" || host.endsWith(".alora.zdots.net") -> 0
            host == "alora.zihan.xyz" || host.endsWith(".alora.zihan.xyz") ||
                host == "ai.zihan.xyz" || host.endsWith(".ai.zihan.xyz") -> 1
            host == "alora-backend-emw3.onrender.com" -> 2
            else -> -1
        }
    }

    private fun buildFailoverUrl(sourceUrl: String?, nextOrigin: String): String {
        if (sourceUrl.isNullOrBlank() || hostIndexForUrl(sourceUrl) < 0) {
            return "$nextOrigin/"
        }
        return try {
            val parsed = Uri.parse(sourceUrl)
            val path = parsed.encodedPath?.takeIf { it.isNotEmpty() } ?: "/"
            val query = parsed.encodedQuery?.let { "?$it" } ?: ""
            val frag = parsed.encodedFragment?.let { "#$it" } ?: ""
            "$nextOrigin$path$query$frag"
        } catch (_: Exception) {
            "$nextOrigin/"
        }
    }

    private fun cancelPendingLoadTimeout() {
        pendingLoadTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingLoadTimeoutRunnable = null
    }

    private fun scheduleLoadTimeout(targetUrl: String?) {
        cancelPendingLoadTimeout()
        val idx = hostIndexForUrl(targetUrl)
        if (idx < 0 || idx >= DOMAIN_FAILOVER_CHAIN.lastIndex) return
        if (!isNetworkAvailable()) return
        val timeoutMs = if (idx == DOMAIN_FAILOVER_CHAIN.lastIndex) RENDER_LOAD_TIMEOUT_MS else EDGE_LOAD_TIMEOUT_MS
        val runnable = Runnable {
            if (isFinishing || isDestroyed) return@Runnable
            val progress = try { webView.progress } catch (_: Exception) { 0 }
            if (progress < 35) {
                Log.w(TAG, "Load timeout on origin[$idx] ($targetUrl), falling back to next domain...")
                tryFailoverToNextOrigin(targetUrl)
            }
        }
        pendingLoadTimeoutRunnable = runnable
        mainHandler.postDelayed(runnable, timeoutMs)
    }

    private fun tryFailoverToNextOrigin(failedUrl: String?): Boolean {
        val failedIdx = hostIndexForUrl(failedUrl).takeIf { it >= 0 } ?: hostIndexForUrl(activeBaseOrigin)
        if (failedIdx >= 0) {
            attemptedOriginsInLoad.add(failedIdx)
        }
        if (!isNetworkAvailable()) {
            return false
        }
        val nextIdx = DOMAIN_FAILOVER_CHAIN.indices.firstOrNull { !attemptedOriginsInLoad.contains(it) }
            ?: return false
        val nextOrigin = DOMAIN_FAILOVER_CHAIN[nextIdx]
        attemptedOriginsInLoad.add(nextIdx)
        activeBaseOrigin = nextOrigin
        val nextUrl = buildFailoverUrl(failedUrl, nextOrigin)
        Log.w(TAG, "Failing over from origin[$failedIdx] to origin[$nextIdx]: $nextUrl")
        cancelPendingLoadTimeout()
        webView.stopLoading()
        webView.loadUrl(nextUrl)
        return true
    }

    private fun isTrustedHost(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        val h = host.lowercase(Locale.US)
        return h == "alora.zdots.net" || h.endsWith(".alora.zdots.net") ||
               h == "alora.zihan.xyz" || h.endsWith(".alora.zihan.xyz") ||
               h == "ai.zihan.xyz" || h.endsWith(".ai.zihan.xyz") ||
               h == "alora-backend-emw3.onrender.com"
    }

    private fun parseQueryOrFragmentParams(raw: String?): Map<String, String> {
        if (raw.isNullOrBlank()) return emptyMap()
        val result = mutableMapOf<String, String>()
        for (pair in raw.split("&")) {
            if (pair.isBlank()) continue
            val idx = pair.indexOf('=')
            val rawKey = if (idx >= 0) pair.substring(0, idx) else pair
            val rawVal = if (idx >= 0) pair.substring(idx + 1) else ""
            val key = try { Uri.decode(rawKey) } catch (_: Exception) { rawKey }
            val value = try { Uri.decode(rawVal) } catch (_: Exception) { rawVal }
            if (key.isNotBlank()) {
                result[key] = value
            }
        }
        return result
    }

    private fun extractTrustedDeepLink(intent: Intent?): String? {
        val data = intent?.data ?: return null
        val scheme = data.scheme?.lowercase(Locale.US) ?: return null
        if (scheme == "alora" && data.host?.lowercase(Locale.US) == "auth") {
            val fragParams = parseQueryOrFragmentParams(data.encodedFragment)
            val queryParams = parseQueryOrFragmentParams(data.encodedQuery)
            val oauthToken = fragParams["oauth_token"] ?: queryParams["oauth_token"]
            val oauthError = fragParams["oauth_error"] ?: queryParams["oauth_error"]
            val rawOrigin = fragParams["origin"] ?: queryParams["origin"]
            val rawRedirect = fragParams["redirect"] ?: queryParams["redirect"]
            val safeRedirect = if (!rawRedirect.isNullOrBlank() && rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")) rawRedirect else "/"

            val parsedOriginUri = rawOrigin?.let { try { Uri.parse(it) } catch (_: Exception) { null } }
            val targetOrigin = if (
                parsedOriginUri != null &&
                parsedOriginUri.scheme?.lowercase(Locale.US) == "https" &&
                isTrustedHost(parsedOriginUri.host)
            ) {
                "https://${parsedOriginUri.host}"
            } else {
                activeBaseOrigin
            }
            activeBaseOrigin = targetOrigin
            val ts = System.currentTimeMillis()

            if (!oauthError.isNullOrBlank()) {
                return "$targetOrigin/auth/login?oauth_error=${Uri.encode(oauthError)}&native_oauth_ts=$ts"
            }
            if (!oauthToken.isNullOrBlank()) {
                try {
                    getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
                        .edit()
                        .putString("auth_token", oauthToken)
                        .apply()
                } catch (_: Exception) {}
                return "$targetOrigin/auth/login?native_oauth_ts=$ts#oauth_token=${Uri.encode(oauthToken)}&redirect=${Uri.encode(safeRedirect)}"
            }
            return "$targetOrigin/auth/login?native_oauth_ts=$ts"
        }
        if (scheme != "https") return null
        return if (isTrustedHost(data.host)) data.toString() else null
    }

    private fun setupEdgeToEdgeInsets() {
        val root = findViewById<View>(R.id.mainRoot) ?: return
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, windowInsets ->
            val sysBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(
                sysBars.left,
                sysBars.top,
                sysBars.right,
                maxOf(sysBars.bottom, ime.bottom)
            )
            WindowInsetsCompat.CONSUMED
        }
    }

    fun applySystemBarsTheme(isLight: Boolean, bgHex: String?) {
        runOnUiThread {
            try {
                val parsed = try {
                    Color.parseColor(bgHex ?: if (isLight) "#FFFFFF" else "#000000")
                } catch (_: Exception) {
                    if (isLight) Color.WHITE else Color.BLACK
                }
                findViewById<View>(R.id.mainRoot)?.setBackgroundColor(parsed)
                if (::webView.isInitialized) {
                    webView.setBackgroundColor(parsed)
                }
                if (::launchVeil.isInitialized && launchVeil.visibility == View.VISIBLE) {
                    launchVeil.setBackgroundColor(parsed)
                    val markColor = if (isLight) Color.parseColor("#0D0D0D") else Color.parseColor("#ECECEC")
                    ivLaunchLogo?.imageTintList = ColorStateList.valueOf(markColor)
                }
                @Suppress("DEPRECATION")
                window.statusBarColor = parsed
                @Suppress("DEPRECATION")
                window.navigationBarColor = parsed
                val controller = WindowInsetsControllerCompat(window, window.decorView)
                controller.isAppearanceLightStatusBars = isLight
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    controller.isAppearanceLightNavigationBars = isLight
                }
            } catch (_: Exception) {}
        }
    }

    private fun enableHighRefreshRate() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val currentDisplay = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                this.display
            } else {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay
            }
            val activeMode = currentDisplay?.mode
            val maxMode = currentDisplay?.supportedModes
                ?.filter {
                    activeMode == null || (
                        it.physicalWidth == activeMode.physicalWidth &&
                        it.physicalHeight == activeMode.physicalHeight
                    )
                }
                ?.maxByOrNull { it.refreshRate }
                ?: currentDisplay?.supportedModes?.maxByOrNull { it.refreshRate }
            maxMode?.let {
                window.attributes = window.attributes.apply {
                    preferredDisplayModeId = it.modeId
                    preferredRefreshRate = it.refreshRate
                }
            }
        }
    }

    private fun initViews() {
        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefreshLayout)
        launchVeil = findViewById(R.id.launchVeil)
        ivLaunchLogo = findViewById(R.id.ivLaunchLogo)
        offlineView = findViewById(R.id.offlineView)

        findViewById<Button>(R.id.btnRetry).setOnClickListener {
            triggerCrispHaptic("light")
            retryLoading()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        val initDark = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        webView.setBackgroundColor(if (initDark) Color.BLACK else Color.WHITE)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = if (isNetworkAvailable()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadsImagesAutomatically = true
            blockNetworkImage = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                offscreenPreRaster = true
            }
            userAgentString = "$userAgentString AloraAndroid/${BuildConfig.VERSION_NAME} AloAI-Android/${BuildConfig.VERSION_NAME}"
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                setAcceptThirdPartyCookies(webView, true)
            }
        }

        webView.apply {
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            isHapticFeedbackEnabled = true
            isSoundEffectsEnabled = false
            setOnLongClickListener {
                val res = hitTestResult
                val t = res.type
                // Suppress browser link/image preview menus so UI feels 100% native
                t == WebView.HitTestResult.SRC_ANCHOR_TYPE ||
                    t == WebView.HitTestResult.IMAGE_TYPE ||
                    t == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
            }
        }

        val wai = WebAppInterface(this)
        webAppInterface = wai
        webView.addJavascriptInterface(wai, "AloAndroid")
        webView.addJavascriptInterface(wai, "AloAI")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    pendingPermissionRequest = request
                    val requiredPermissions = mutableListOf<String>()

                    for (resource in request.resources) {
                        when (resource) {
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                    requiredPermissions.add(Manifest.permission.RECORD_AUDIO)
                                }
                            }
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                                    requiredPermissions.add(Manifest.permission.CAMERA)
                                }
                            }
                        }
                    }

                    if (requiredPermissions.isNotEmpty()) {
                        permissionLauncher.launch(requiredPermissions.toTypedArray())
                    } else {
                        request.grant(request.resources)
                    }
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val takePictureIntent = createCameraIntent()

                val contentSelectionIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    val acceptTypes = fileChooserParams.acceptTypes
                    if (acceptTypes != null && acceptTypes.isNotEmpty()) {
                        if (acceptTypes.size == 1 && acceptTypes[0].trim().isNotEmpty()) {
                            type = acceptTypes[0]
                        } else {
                            putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
                        }
                    }
                }

                val intentArray = if (takePictureIntent != null) arrayOf(takePictureIntent) else emptyArray()
                val chooserIntent = Intent(Intent.ACTION_CHOOSER).apply {
                    putExtra(Intent.EXTRA_INTENT, contentSelectionIntent)
                    putExtra(Intent.EXTRA_TITLE, getString(R.string.file_chooser_title))
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, intentArray)
                }

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot launch file chooser", e)
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = null
                    false
                }
            }

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Alora")
                    .setMessage(message ?: "")
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Alora")
                    .setMessage(message ?: "")
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, "[WebView Console] ${consoleMessage.message()} -- From line ${consoleMessage.lineNumber()} of ${consoleMessage.sourceId()}")
                }
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!request.method.equals("GET", ignoreCase = true)) return null
                val uri = request.url ?: return null
                val scheme = uri.scheme?.lowercase(Locale.US) ?: return null
                val host = uri.host?.lowercase(Locale.US) ?: return null
                val isAppOrigin = scheme == "https" && (
                    isTrustedHost(host) ||
                    host == "zihanfakir.github.io" ||
                    host == "zihanfakir.gitlab.io"
                )
                if (!isAppOrigin) return null

                val rawPath = uri.path ?: "/"
                if (rawPath.startsWith("/api/") || rawPath == "/api" ||
                    rawPath.startsWith("/chat/") ||
                    rawPath.startsWith("/socket.io") ||
                    rawPath.startsWith("/.well-known/") ||
                    rawPath.startsWith("/auth/google") ||
                    rawPath.startsWith("/auth/discord") ||
                    rawPath.startsWith("/zihan") ||
                    rawPath.startsWith("/admin") ||
                    rawPath == "/sw.js" ||
                    rawPath.endsWith(".apk", ignoreCase = true) ||
                    rawPath.endsWith(".ipa", ignoreCase = true)
                ) {
                    return null
                }

                val assetRel = when {
                    rawPath == "/" || rawPath == "/index" || rawPath == "/index.html" ||
                        rawPath.startsWith("/c/") || rawPath.startsWith("/g/") || rawPath.startsWith("/share/") ||
                        rawPath == "/settings" || rawPath.startsWith("/settings/") -> "index.html"
                    rawPath == "/auth/login" || rawPath == "/auth/signup" || rawPath == "/login" || rawPath == "/signup" || rawPath == "/login.html" -> "login.html"
                    rawPath == "/pricing" || rawPath == "/plans" || rawPath == "/plans.html" -> "plans.html"
                    rawPath == "/checkout" || rawPath == "/checkout.html" -> "checkout.html"
                    rawPath == "/account" || rawPath == "/account.html" -> "account.html"
                    rawPath == "/profile" || rawPath == "/profile.html" -> "profile.html"
                    rawPath == "/security" || rawPath == "/security.html" -> "security.html"
                    rawPath == "/personalization" || rawPath == "/personalization.html" -> "personalization.html"
                    rawPath == "/help" || rawPath == "/help.html" -> "help.html"
                    rawPath == "/redeem" || rawPath == "/redeem.html" -> "redeem.html"
                    rawPath == "/download" || rawPath == "/download.html" -> "download.html"
                    rawPath == "/404" || rawPath == "/404.html" -> "404.html"
                    else -> rawPath.trimStart('/').takeIf {
                        it.isNotEmpty() && !it.contains("..") && !it.startsWith("server/")
                    }
                } ?: return null

                val lower = assetRel.lowercase(Locale.US)
                val isHtmlPage = lower.endsWith(".html")
                val mime = when {
                    isHtmlPage -> "text/html"
                    lower.endsWith(".json") -> "application/json"
                    lower.endsWith(".png") -> "image/png"
                    lower.endsWith(".svg") -> "image/svg+xml"
                    lower.endsWith(".ico") -> "image/x-icon"
                    lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
                    lower.endsWith(".webp") -> "image/webp"
                    lower.endsWith(".js") -> "application/javascript"
                    lower.endsWith(".css") -> "text/css"
                    else -> "application/octet-stream"
                }
                val encoding = if (mime.startsWith("text/") || mime == "application/json" || mime == "application/javascript" || mime == "image/svg+xml") {
                    "UTF-8"
                } else {
                    null
                }

                // Zero-Gap Stale-While-Revalidate: ALWAYS serve HTML immediately (<1ms) from live_www/
                // when valid, falling back instantaneously to bundled assets/www/. Never block UI on network.
                if (isHtmlPage && LIVE_HTML_PAGE_SET.contains(assetRel)) {
                    val liveFile = File(liveWwwDir, assetRel)
                    if (isValidCachedHtmlFile(liveFile)) {
                        try {
                            val stream = BufferedInputStream(FileInputStream(liveFile))
                            return WebResourceResponse(
                                mime,
                                encoding,
                                200,
                                "OK",
                                mapOf("Cache-Control" to "no-store"),
                                stream
                            )
                        } catch (_: Exception) {
                            // Fall through to bundled asset below
                        }
                    }
                    return try {
                        val stream = assets.open("www/$assetRel")
                        WebResourceResponse(
                            mime,
                            encoding,
                            200,
                            "OK",
                            mapOf("Cache-Control" to "no-store"),
                            stream
                        )
                    } catch (_: Exception) {
                        null
                    }
                }

                return try {
                    val stream = assets.open("www/$assetRel")
                    WebResourceResponse(mime, encoding, stream)
                } catch (_: Exception) {
                    null
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme?.lowercase(Locale.US) ?: return true

                if (scheme == "https" && isTrustedHost(uri.host)) {
                    return false
                }

                if (scheme != "https" && scheme != "http" && scheme != "mailto" && scheme != "tel") {
                    return true
                }

                return try {
                    val launchIntent = Intent(Intent.ACTION_VIEW, uri).apply {
                        if (scheme == "https" || scheme == "http") {
                            val extras = Bundle().apply {
                                putBinder("android.support.customtabs.extra.SESSION", null)
                                putInt("android.support.customtabs.extra.TOOLBAR_COLOR", Color.parseColor("#000000"))
                                putInt("android.support.customtabs.extra.TITLE_VISIBILITY", 1)
                                putInt("android.support.customtabs.extra.SHARE_MENU_ITEM", 2)
                            }
                            putExtras(extras)
                        }
                    }
                    startActivity(launchIntent)
                    true
                } catch (e: Exception) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (e2: Exception) {
                        Log.w(TAG, "Could not launch external URL: $uri", e2)
                    }
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (url != null && url != "about:blank" && !url.startsWith("data:") && !url.startsWith("chrome-error:")) {
                    currentLoadHadMainFrameError = false
                    val startedIdx = hostIndexForUrl(url)
                    if (startedIdx >= 0) {
                        attemptedOriginsInLoad.add(startedIdx)
                    }
                    scheduleLoadTimeout(url)
                }
                val hideAppBannerJs = """
                    (function(){
                        window.isAndroidApp = true;
                        if (document.documentElement) document.documentElement.classList.add('is-android-app');
                        if (document.body) document.body.classList.add('is-android-app');
                        var s = document.getElementById('alo-android-early-style');
                        if (!s) {
                            s = document.createElement('style');
                            s.id = 'alo-android-early-style';
                            s.textContent = '.android-only-hide,#heroAppDownloadBanner,#drawerDownloadAppWrap,#brandMenuDownloadAppBtn,#appDownloadModalOverlay,.hero-app-banner{display:none!important;visibility:hidden!important;height:0!important;margin:0!important;padding:0!important;}';
                            (document.head || document.documentElement).appendChild(s);
                        }
                    })();
                """.trimIndent()
                view.evaluateJavascript(hideAppBannerJs, null)
            }

            override fun onPageCommitVisible(view: WebView, url: String?) {
                super.onPageCommitVisible(view, url)
                cancelPendingLoadTimeout()
                if (!url.isNullOrBlank() && url != "about:blank" && !url.startsWith("data:") && !url.startsWith("chrome-error:")) {
                    hasInitialPaintCommitted = true
                    dismissLaunchVeil()
                    scheduleLiveHtmlSync(force = false)
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false
                if (currentLoadHadMainFrameError || url.isNullOrBlank() || url == "about:blank" || url.startsWith("data:") || url.startsWith("chrome-error:")) {
                    return
                }
                val finishedIdx = hostIndexForUrl(url)
                if (finishedIdx >= 0 && finishedIdx != hostIndexForUrl(activeBaseOrigin)) {
                    return
                }
                cancelPendingLoadTimeout()

                val cleanupJs = """
                    (function(){
                        window.isAndroidApp = true;
                        if (document.documentElement) document.documentElement.classList.add('is-android-app');
                        if (document.body) document.body.classList.add('is-android-app');
                        var b = document.getElementById('heroAppDownloadBanner');
                        if (b) b.remove();
                        try {
                            var meta = document.querySelector('meta[name="theme-color"]');
                            var eff = document.documentElement ? document.documentElement.getAttribute('data-theme') : 'dark';
                            var fallbackBg = eff === 'light' ? '#ffffff' : (eff === 'eyecare' ? '#f5eedc' : '#000000');
                            var bg = (meta && meta.content) || fallbackBg;
                            if (window.AloAI && window.AloAI.setSystemBarsTheme) {
                                window.AloAI.setSystemBarsTheme(eff === 'light' || eff === 'eyecare', bg);
                            }
                        } catch(e){}
                    })();
                """.trimIndent()
                view.evaluateJavascript(cleanupJs, null)

                // Inject Native Auth Token safely if WebView has no active session
                val prefs = getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
                val token = prefs.getString("auth_token", null)
                val userName = prefs.getString("user_name", null) ?: ""
                val userEmail = prefs.getString("user_email", null) ?: ""
                val userPlan = prefs.getString("user_plan", null) ?: ""
                if (!token.isNullOrBlank()) {
                    val qToken = JSONObject.quote(token)
                    val qName = JSONObject.quote(userName)
                    val qEmail = JSONObject.quote(userEmail)
                    val userObj = JSONObject().apply {
                        put("name", userName)
                        put("email", userEmail)
                    }.toString()
                    val qUserJson = JSONObject.quote(userObj)
                    val js = StringBuilder()
                    js.append("(function(){ try { if (!localStorage.getItem('alokpoth_token')) {")
                    js.append("localStorage.setItem('alokpoth_token', $qToken);")
                    js.append("localStorage.setItem('alokpoth_account_name', $qName);")
                    js.append("localStorage.setItem('alokpoth_name', $qName);")
                    js.append("localStorage.setItem('alokpoth_email', $qEmail);")
                    js.append("localStorage.setItem('alokpoth_user', $qUserJson);")
                    if (userPlan.isNotBlank()) {
                        val qPlan = JSONObject.quote(userPlan)
                        js.append("localStorage.setItem('alokpoth_current_plan', $qPlan);")
                        js.append("localStorage.setItem('alokpoth_user_plan', $qPlan);")
                        js.append("localStorage.setItem('alokpoth_plan', $qPlan);")
                    }
                    js.append("if (typeof syncUserUI === 'function') syncUserUI();")
                    js.append("if (typeof refreshUserFromServer === 'function') refreshUserFromServer();")
                    js.append("} } catch(e){} })();")
                    view.evaluateJavascript(js.toString(), null)
                }

                // Sync web session back to native storage (or clear native storage on logout)
                val syncBackJs = """
                    (function(){
                        try {
                            var t = localStorage.getItem('alokpoth_token');
                            if (t && window.AloAI && window.AloAI.saveAuth) {
                                var u = {};
                                try { u = JSON.parse(localStorage.getItem('alokpoth_user') || '{}') || {}; } catch(err){}
                                var n = u.name || localStorage.getItem('alokpoth_account_name') || localStorage.getItem('alokpoth_name') || '';
                                var e = u.email || localStorage.getItem('alokpoth_email') || '';
                                var p = (u.subscription && u.subscription.plan_name) || localStorage.getItem('alokpoth_current_plan') || localStorage.getItem('alokpoth_user_plan') || 'Free';
                                window.AloAI.saveAuth(t, n, e, p);
                            } else if (!t && window.AloAI && window.AloAI.clearAuth) {
                                window.AloAI.clearAuth();
                            }
                        } catch(err){}
                    })();
                """.trimIndent()
                view.evaluateJavascript(syncBackJs, null)

                hostIndexForUrl(url).takeIf { it >= 0 }?.let { idx ->
                    activeBaseOrigin = DOMAIN_FAILOVER_CHAIN[idx]
                }
                attemptedOriginsInLoad.clear()
                hasLoadedPageSuccessfully = true
                showOfflineView(false)
                dismissLaunchVeil()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                super.onReceivedError(view, request, error)
                if (!request.isForMainFrame) return
                val failingUrl = request.url?.toString()
                if (hostIndexForUrl(failingUrl) != hostIndexForUrl(activeBaseOrigin)) {
                    return
                }
                Log.e(TAG, "Page load error on $failingUrl: ${error.description}")
                currentLoadHadMainFrameError = true
                cancelPendingLoadTimeout()
                if (tryFailoverToNextOrigin(failingUrl)) {
                    return
                }
                attemptedOriginsInLoad.clear()
                if (!hasLoadedPageSuccessfully) {
                    showOfflineView(true)
                } else {
                    Toast.makeText(this@MainActivity, getString(R.string.error_offline_title), Toast.LENGTH_SHORT).show()
                }
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                super.onReceivedHttpError(view, request, errorResponse)
                if (!request.isForMainFrame) return
                val failingUrl = request.url?.toString()
                if (hostIndexForUrl(failingUrl) != hostIndexForUrl(activeBaseOrigin)) {
                    return
                }
                val status = errorResponse.statusCode
                if (status < 500 && !(status == 404 && !hasLoadedPageSuccessfully)) {
                    return
                }
                Log.e(TAG, "HTTP $status on $failingUrl, failing over if available")
                currentLoadHadMainFrameError = true
                cancelPendingLoadTimeout()
                if (tryFailoverToNextOrigin(failingUrl)) {
                    return
                }
                attemptedOriginsInLoad.clear()
                if (!hasLoadedPageSuccessfully) {
                    showOfflineView(true)
                }
            }
        }

        webView.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            handleDownload(url, contentDisposition, mimetype)
        }
    }

    private fun setupSwipeRefresh() {
        swipeRefresh.setColorSchemeResources(R.color.primary)
        swipeRefresh.setProgressBackgroundColorSchemeResource(R.color.surface)
        swipeRefresh.isEnabled = false
        swipeRefresh.setOnChildScrollUpCallback { _, _ ->
            !::webView.isInitialized || webView.canScrollVertically(-1) || webView.scrollY > 0
        }

        swipeRefresh.setOnRefreshListener {
            if (isNetworkAvailable()) {
                webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
                webView.reload()
                scheduleLiveHtmlSync(force = true)
            } else {
                webView.settings.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
                webView.reload()
                swipeRefresh.isRefreshing = false
            }
        }
    }

    fun reloadWebView() {
        showOfflineView(false)
        webView.settings.cacheMode = if (isNetworkAvailable()) {
            WebSettings.LOAD_DEFAULT
        } else {
            WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        webView.reload()
        scheduleLiveHtmlSync(force = true)
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){ try { if (typeof window.handleAppBackButton === 'function') { return window.handleAppBackButton(); } } catch(e){} return false; })()"
                ) { result ->
                    val handled = result?.trim()?.equals("true", ignoreCase = true) == true
                    if (!handled) {
                        if (webView.canGoBack()) {
                            triggerCrispHaptic("light")
                            webView.goBack()
                        } else {
                            val currentTime = System.currentTimeMillis()
                            if (currentTime - lastBackPressTime < BACK_PRESS_INTERVAL) {
                                finish()
                            } else {
                                lastBackPressTime = currentTime
                                triggerCrispHaptic("light")
                                Toast.makeText(this@MainActivity, getString(R.string.exit_prompt), Toast.LENGTH_SHORT).show()
                            }
                        }
                    } else {
                        triggerCrispHaptic("light")
                    }
                }
            }
        })
    }

    private fun retryLoading() {
        showOfflineView(false)
        attemptedOriginsInLoad.clear()
        activeBaseOrigin = PRIMARY_ORIGIN
        webView.settings.cacheMode = if (isNetworkAvailable()) {
            WebSettings.LOAD_DEFAULT
        } else {
            WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        val current = webView.url
        val targetUrl = buildFailoverUrl(current, PRIMARY_ORIGIN)
        webView.loadUrl(targetUrl)
    }

    private fun showOfflineView(show: Boolean) {
        if (show && ::launchVeil.isInitialized) {
            launchVeil.animate().cancel()
            launchVeil.visibility = View.GONE
            launchVeil.alpha = 1f
            isLaunchVeilDismissing = false
        }
        offlineView.visibility = if (show) View.VISIBLE else View.GONE
        webView.visibility = if (show) View.GONE else View.VISIBLE
        swipeRefresh.isEnabled = false
        swipeRefresh.isRefreshing = false
    }

    private fun createCameraIntent(): Intent? {
        val takePictureIntent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
        if (takePictureIntent.resolveActivity(packageManager) != null) {
            val photoFile = try {
                createImageFile()
            } catch (ex: IOException) {
                Log.e(TAG, "Cannot create photo file", ex)
                null
            }
            if (photoFile != null) {
                cameraPhotoUri = FileProvider.getUriForFile(
                    this,
                    "$packageName.fileprovider",
                    photoFile
                )
                takePictureIntent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, cameraPhotoUri)
                return takePictureIntent
            }
        }
        return null
    }

    @Throws(IOException::class)
    private fun createImageFile(): File {
        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val imageFileName = "JPEG_${timeStamp}_"
        val storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES)
        return File.createTempFile(imageFileName, ".jpg", storageDir)
    }

    private fun handleDownload(url: String, contentDisposition: String, mimeType: String) {
        try {
            if (url.startsWith("data:")) {
                saveDataUri(url, mimeType)
                return
            }

            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType)
                val cookies = CookieManager.getInstance().getCookie(url)
                addRequestHeader("cookie", cookies)
                addRequestHeader("User-Agent", webView.settings.userAgentString)
                setDescription(getString(R.string.download_started))
                val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
                setTitle(filename)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            }

            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
            if (dm != null) {
                dm.enqueue(request)
                Toast.makeText(this, getString(R.string.download_started), Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Download failed", e)
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun saveDataUri(dataUri: String, mimeType: String?) {
        try {
            val commaIndex = dataUri.indexOf(",")
            if (commaIndex == -1) return

            val base64Data = dataUri.substring(commaIndex + 1)
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)

            val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val isPng = mimeType != null && mimeType.contains("png")
            val ext = if (isPng) ".png" else ".jpg"
            val resolvedMime = if (isPng) "image/png" else "image/jpeg"
            val filename = "Alora_$timeStamp$ext"

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(android.provider.MediaStore.Downloads.MIME_TYPE, resolvedMime)
                    put(android.provider.MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IOException("Failed to create MediaStore download entry")
                contentResolver.openOutputStream(uri)?.use { fos ->
                    fos.write(bytes)
                    fos.flush()
                } ?: throw IOException("Failed to open download output stream")
            } else {
                val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                val file = File(downloadsDir, filename)
                FileOutputStream(file).use { fos ->
                    fos.write(bytes)
                    fos.flush()
                }
            }

            Toast.makeText(this, "${getString(R.string.download_complete)}: $filename", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.e(TAG, "Error saving data URI", e)
            Toast.makeText(this, getString(R.string.save_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val network = cm.activeNetwork ?: return false
            val capabilities = cm.getNetworkCapabilities(network) ?: return false
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        } else {
            @Suppress("DEPRECATION")
            cm.activeNetworkInfo?.isConnected == true
        }
    }

    fun notifyTtsPlaybackDone() {
        mainHandler.post {
            if (::webView.isInitialized) {
                webView.evaluateJavascript("if (typeof window.onNativeTtsDone === 'function') window.onNativeTtsDone();", null)
            }
        }
    }

    fun isNetworkAvailablePublic(): Boolean = isNetworkAvailable()

    private fun registerNetworkMonitor() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || networkCallback != null) return
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    mainHandler.post {
                        if (::webView.isInitialized) {
                            webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
                            webView.evaluateJavascript("if (typeof window.onNativeNetworkChanged === 'function') window.onNativeNetworkChanged(true);", null)
                        }
                        if (hasInitialPaintCommitted) {
                            scheduleLiveHtmlSync(force = false)
                        }
                    }
                }
                override fun onLost(network: Network) {
                    mainHandler.postDelayed({
                        val stillOnline = isNetworkAvailable()
                        if (::webView.isInitialized) {
                            webView.settings.cacheMode = if (stillOnline) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
                            webView.evaluateJavascript("if (typeof window.onNativeNetworkChanged === 'function') window.onNativeNetworkChanged($stillOnline);", null)
                        }
                    }, 350)
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (_: Exception) {}
    }

    private fun unregisterNetworkMonitor() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val cb = networkCallback ?: return
        networkCallback = null
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            cm?.unregisterNetworkCallback(cb)
        } catch (_: Exception) {}
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        registerNetworkMonitor()
        if (::webView.isInitialized) {
            val online = isNetworkAvailable()
            webView.evaluateJavascript("if (typeof window.onNativeNotificationPermissionChanged === 'function') window.onNativeNotificationPermissionChanged(); if (typeof window.onNativeNetworkChanged === 'function') window.onNativeNetworkChanged($online);", null)
            if (online && hasInitialPaintCommitted) {
                scheduleLiveHtmlSync(force = false)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        unregisterNetworkMonitor()
        webView.onPause()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= TRIM_MEMORY_MODERATE) {
            webView.clearCache(false)
        }
    }

    fun logoutAndGoToAuth() {
        try {
            val prefs = getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
            prefs.edit().clear().apply()

            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()

            attemptedOriginsInLoad.clear()
            webView.post {
                webView.loadUrl("$activeBaseOrigin/")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error logging out", e)
        }
    }

    private fun dismissLaunchVeil() {
        if (!::launchVeil.isInitialized) return
        if (launchVeil.visibility != View.VISIBLE || isLaunchVeilDismissing) return
        isLaunchVeilDismissing = true
        launchVeil.animate()
            .alpha(0f)
            .setDuration(140L)
            .withEndAction {
                launchVeil.visibility = View.GONE
                launchVeil.alpha = 1f
                isLaunchVeilDismissing = false
            }
            .start()
    }

    fun triggerCrispHaptic(type: String = "light") {
        try {
            if (::webView.isInitialized) {
                val constant = when (type.lowercase(Locale.US)) {
                    "heavy" -> HapticFeedbackConstants.LONG_PRESS
                    "medium", "confirm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        HapticFeedbackConstants.CONFIRM
                    } else {
                        HapticFeedbackConstants.CONTEXT_CLICK
                    }
                    else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                        HapticFeedbackConstants.TEXT_HANDLE_MOVE
                    } else {
                        HapticFeedbackConstants.KEYBOARD_TAP
                    }
                }
                if (webView.performHapticFeedback(constant)) {
                    return
                }
            }
            webAppInterface?.haptic(type)
        } catch (_: Exception) {}
    }

    private fun ensureLiveWwwCacheReady() {
        try {
            val dir = liveWwwDir
            if (!dir.exists()) {
                dir.mkdirs()
            }
            val prefs = getSharedPreferences(LIVE_WWW_PREFS, Context.MODE_PRIVATE)
            val cachedVer = prefs.getInt(KEY_LIVE_VERSION_CODE, -1)
            val verMarker = File(dir, "$VERSION_MARKER_PREFIX${BuildConfig.VERSION_CODE}")
            val versionChanged = cachedVer != BuildConfig.VERSION_CODE || !verMarker.exists()

            if (versionChanged) {
                dir.listFiles()?.forEach { f ->
                    try {
                        if (f.isDirectory) f.deleteRecursively() else f.delete()
                    } catch (_: Exception) {}
                }
                prefs.edit()
                    .clear()
                    .putInt(KEY_LIVE_VERSION_CODE, BuildConfig.VERSION_CODE)
                    .apply()
                try { verMarker.createNewFile() } catch (_: Exception) {}
                shouldClearWebViewCacheOnVersionChange = true
            } else {
                dir.listFiles()?.forEach { f ->
                    val name = f.name
                    val keep = name == verMarker.name || (f.isFile && LIVE_HTML_PAGE_SET.contains(name))
                    if (!keep) {
                        try {
                            if (f.isDirectory) f.deleteRecursively() else f.delete()
                        } catch (_: Exception) {}
                    }
                }
            }

            cacheDir.listFiles()?.forEach { f ->
                if (f.isFile && f.name.endsWith(".tmp", ignoreCase = true)) {
                    try { f.delete() } catch (_: Exception) {}
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to initialize live_www cache", e)
        }
    }

    private fun isValidCachedHtmlFile(file: File): Boolean {
        if (!file.exists() || !file.isFile) return false
        val len = file.length()
        if (len <= 512L) return false
        return try {
            val headSize = minOf(len, 4096L).toInt()
            val buf = ByteArray(headSize)
            var readTotal = 0
            FileInputStream(file).use { fis ->
                while (readTotal < headSize) {
                    val n = fis.read(buf, readTotal, headSize - readTotal)
                    if (n <= 0) break
                    readTotal += n
                }
            }
            if (readTotal <= 0) return false
            val head = String(buf, 0, readTotal, Charsets.UTF_8)
            head.contains("<html", ignoreCase = true) || head.contains("<!doctype", ignoreCase = true)
        } catch (_: Exception) {
            false
        }
    }

    private fun isValidDownloadedHtml(bytes: ByteArray): Boolean {
        if (bytes.size <= 512 || bytes.size > 10 * 1024 * 1024) return false
        val headLen = minOf(bytes.size, 4096)
        val head = String(bytes, 0, headLen, Charsets.UTF_8)
        if (!head.contains("<html", ignoreCase = true) && !head.contains("<!doctype", ignoreCase = true)) {
            return false
        }
        val tailStart = maxOf(0, bytes.size - 2048)
        val tail = String(bytes, tailStart, bytes.size - tailStart, Charsets.UTF_8)
        return tail.contains("</html>", ignoreCase = true) || String(bytes, Charsets.UTF_8).contains("</html>", ignoreCase = true)
    }

    private fun digestToHex(digest: ByteArray): String {
        val hex = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            if (v < 16) hex.append('0')
            hex.append(Integer.toHexString(v))
        }
        return hex.toString()
    }

    private fun sha256Bytes(bytes: ByteArray): String {
        return digestToHex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }

    private fun sha256File(file: File): String? {
        return try {
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(8192)
            FileInputStream(file).use { fis ->
                while (true) {
                    val n = fis.read(buf)
                    if (n <= 0) break
                    md.update(buf, 0, n)
                }
            }
            digestToHex(md.digest())
        } catch (_: Exception) {
            null
        }
    }

    private fun getOrComputeBundledSha256(prefs: SharedPreferences, assetRel: String): String? {
        val key = "v${BuildConfig.VERSION_CODE}_bundled_sha_$assetRel"
        prefs.getString(key, null)?.let { return it }
        return try {
            val bytes = assets.open("www/$assetRel").use { it.readBytes() }
            val sha = sha256Bytes(bytes)
            prefs.edit().putString(key, sha).apply()
            sha
        } catch (_: Exception) {
            null
        }
    }

    private fun writeFileAtomically(dir: File, targetName: String, bytes: ByteArray): Boolean {
        if (!dir.exists()) dir.mkdirs()
        val tmpFile = File(dir, "$targetName.tmp")
        val targetFile = File(dir, targetName)
        return try {
            FileOutputStream(tmpFile).use { fos ->
                fos.write(bytes)
                fos.flush()
                try { fos.fd.sync() } catch (_: Exception) {}
            }
            if (tmpFile.renameTo(targetFile)) {
                true
            } else {
                targetFile.delete()
                if (tmpFile.renameTo(targetFile)) {
                    true
                } else {
                    tmpFile.copyTo(targetFile, overwrite = true)
                    tmpFile.delete()
                    true
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Atomic write failed for $targetName", e)
            try { tmpFile.delete() } catch (_: Exception) {}
            false
        }
    }

    private fun scheduleLiveHtmlSync(force: Boolean = false) {
        if (isFinishing || isDestroyed) return
        if (!isNetworkAvailable()) return
        val now = SystemClock.elapsedRealtime()
        if (!force && hasSyncedOnLaunch && (now - lastLiveSyncElapsedMs) < LIVE_SYNC_INTERVAL_MS) {
            return
        }
        if (!isLiveSyncRunning.compareAndSet(false, true)) {
            return
        }
        hasSyncedOnLaunch = true
        lastLiveSyncElapsedMs = now
        try {
            liveSyncExecutor.execute {
                try {
                    syncLiveHtmlCacheInBackground()
                } finally {
                    isLiveSyncRunning.set(false)
                }
            }
        } catch (_: Exception) {
            isLiveSyncRunning.set(false)
        }
    }

    private fun syncLiveHtmlCacheInBackground() {
        val prefs = getSharedPreferences(LIVE_WWW_PREFS, Context.MODE_PRIVATE)
        val candidates = mutableListOf<String>()
        val currentOrigin = activeBaseOrigin.takeIf { it.startsWith("https://") } ?: PRIMARY_ORIGIN
        candidates.add(currentOrigin)
        if (currentOrigin != PRIMARY_ORIGIN) candidates.add(PRIMARY_ORIGIN)
        if (!candidates.contains(SECONDARY_ORIGIN)) candidates.add(SECONDARY_ORIGIN)

        var chosenOrigin: String? = null
        var latestIndexRemoteSha: String? = null
        var anyHttpSuccess = false

        for (assetRel in LIVE_HTML_PAGES) {
            if (isFinishing || isDestroyed || !isNetworkAvailable()) break
            if (assetRel != "index.html" && chosenOrigin == null) break

            val originsToTry = if (chosenOrigin != null) listOf(chosenOrigin) else candidates
            val currentFile = File(liveWwwDir, assetRel)
            val liveValid = isValidCachedHtmlFile(currentFile)
            val currentSha = if (liveValid) sha256File(currentFile) else getOrComputeBundledSha256(prefs, assetRel)
            val shaKey = "v${BuildConfig.VERSION_CODE}_sha256_$assetRel"
            val etagKey = "v${BuildConfig.VERSION_CODE}_etag_$assetRel"
            val savedSha = prefs.getString(shaKey, null)
            val savedEtag = prefs.getString(etagKey, null)
            val canSendEtag = !savedEtag.isNullOrBlank() && currentSha != null && savedSha == currentSha

            for (origin in originsToTry) {
                try {
                    val reqBuilder = Request.Builder()
                        .url("$origin/$assetRel")
                        .header("Cache-Control", "no-cache")
                        .header("User-Agent", "AloraAndroid/${BuildConfig.VERSION_NAME}")
                    if (canSendEtag) {
                        reqBuilder.header("If-None-Match", savedEtag!!)
                    }

                    val pageDone = liveSyncHttpClient.newCall(reqBuilder.build()).execute().use { resp ->
                        if (resp.code == 304) {
                            anyHttpSuccess = true
                            chosenOrigin = origin
                            return@use true
                        }
                        if (!resp.isSuccessful) {
                            return@use false
                        }
                        val ct = resp.header("Content-Type")?.lowercase(Locale.US)
                        if (ct != null && !ct.contains("text/html")) {
                            return@use false
                        }
                        val bytes = resp.body?.bytes() ?: return@use false
                        if (!isValidDownloadedHtml(bytes)) {
                            return@use false
                        }

                        anyHttpSuccess = true
                        chosenOrigin = origin
                        val remoteSha = sha256Bytes(bytes)
                        if (assetRel == "index.html") {
                            latestIndexRemoteSha = remoteSha
                        } else if (latestIndexRemoteSha != null && remoteSha == latestIndexRemoteSha) {
                            // Guard against SPA fallback returning index.html for secondary routes
                            return@use true
                        }

                        val newEtag = resp.header("ETag")?.trim()
                        val changed = remoteSha != currentSha
                        val persisted = !changed || writeFileAtomically(liveWwwDir, assetRel, bytes)
                        if (persisted) {
                            prefs.edit()
                                .putString(shaKey, remoteSha)
                                .apply {
                                    if (!newEtag.isNullOrBlank()) putString(etagKey, newEtag)
                                    else remove(etagKey)
                                }
                                .apply()
                            if (changed && assetRel == "index.html") {
                                onLiveIndexHtmlUpdated()
                            }
                        }
                        true
                    }
                    if (pageDone) break
                } catch (_: Exception) {
                    // Try fallback edge origin if available
                }
            }
        }

        if (!anyHttpSuccess) {
            hasSyncedOnLaunch = false
            lastLiveSyncElapsedMs = SystemClock.elapsedRealtime() - LIVE_SYNC_INTERVAL_MS + 30_000L
        }
    }

    private fun onLiveIndexHtmlUpdated() {
        hasPendingIndexUpdate = true
        val arrivedWithinColdWindow = (SystemClock.elapsedRealtime() - appLaunchElapsedMs) <= COLD_LAUNCH_APPLY_WINDOW_MS
        mainHandler.post {
            if (isFinishing || isDestroyed || !::webView.isInitialized) return@post
            webView.evaluateJavascript(
                "if (typeof window.onNativeLiveUpdateReady === 'function') window.onNativeLiveUpdateReady();",
                null
            )
            if (arrivedWithinColdWindow) {
                applyPendingUpdateIfIdleInternal()
            }
        }
    }

    fun hasPendingLiveUpdate(): Boolean = hasPendingIndexUpdate

    fun applyPendingUpdateIfIdleFromJs(): Boolean {
        if (!hasPendingIndexUpdate || isFinishing || isDestroyed) return false
        if (isSpeechListening || isCustomAudioRecording) return false
        mainHandler.post { applyPendingUpdateIfIdleInternal() }
        return true
    }

    private fun applyPendingUpdateIfIdleInternal() {
        if (!hasPendingIndexUpdate || isFinishing || isDestroyed || !::webView.isInitialized) return
        if (isSpeechListening || isCustomAudioRecording) return
        val currentUrl = webView.url ?: return
        val path = try { Uri.parse(currentUrl).path ?: "/" } catch (_: Exception) { return }
        if (path != "/" && path != "/index" && path != "/index.html") return

        val idleCheckJs = """
            (function(){
                try {
                    if (typeof isGenerating !== 'undefined' && isGenerating) return false;
                    if (typeof isSending !== 'undefined' && isSending) return false;
                    if (typeof currentSessionId !== 'undefined' && currentSessionId) return false;
                    if (typeof messagesHistory !== 'undefined' && Array.isArray(messagesHistory) && messagesHistory.length > 0) return false;
                    var feed = document.getElementById('chatFeed');
                    if (feed && feed.children && feed.children.length > 0) return false;
                    var inp = document.getElementById('messageInput');
                    if (inp && ((inp.value && inp.value.trim().length > 0) || document.activeElement === inp)) return false;
                    var vm = document.getElementById('voiceModeBackdrop');
                    if (vm && vm.classList && vm.classList.contains('open')) return false;
                    if (document.querySelector('.modal-overlay.open, .chatgpt-modal-backdrop.open, .chatgpt-dialog-backdrop.open, #sidebar.open')) return false;
                    return true;
                } catch(e) { return false; }
            })()
        """.trimIndent()

        webView.evaluateJavascript(idleCheckJs) { result ->
            if (isFinishing || isDestroyed || !hasPendingIndexUpdate) return@evaluateJavascript
            if (isSpeechListening || isCustomAudioRecording) return@evaluateJavascript
            val isIdle = result?.trim()?.equals("true", ignoreCase = true) == true
            if (isIdle) {
                hasPendingIndexUpdate = false
                attemptedOriginsInLoad.clear()
                webView.reload()
            }
        }
    }

    override fun onDestroy() {
        cancelPendingLoadTimeout()
        if (::launchVeil.isInitialized) {
            launchVeil.animate().cancel()
        }
        try { liveSyncExecutor.shutdownNow() } catch (_: Exception) {}
        stopCustomAudioInternal(deliverCapture = false)
        destroySpeechRecognizer()
        webAppInterface?.destroy()
        webView.destroy()
        super.onDestroy()
    }
}

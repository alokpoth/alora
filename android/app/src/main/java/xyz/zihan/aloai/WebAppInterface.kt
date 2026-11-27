package xyz.zihan.aloai

import android.Manifest
import android.app.DownloadManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.util.Locale

class WebAppInterface(private val activity: MainActivity) : TextToSpeech.OnInitListener {

    private var tts: TextToSpeech? = null
    @Volatile private var isTtsInitialized = false
    private data class PendingTtsSpeech(
        val text: String,
        val lang: String?,
        val pitch: Float,
        val rate: Float,
        val gender: String?
    )
    @Volatile private var pendingTtsSpeech: PendingTtsSpeech? = null

    init {
        try {
            tts = TextToSpeech(activity.applicationContext, this)
        } catch (_: Exception) {}
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            isTtsInitialized = true
            try {
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        activity.notifyTtsPlaybackDone()
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        activity.notifyTtsPlaybackDone()
                    }
                    override fun onError(utteranceId: String?, errorCode: Int) {
                        activity.notifyTtsPlaybackDone()
                    }
                })
                val bnLocale = Locale("bn", "BD")
                val result = tts?.setLanguage(bnLocale)
                if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                    tts?.setLanguage(Locale.US)
                }
            } catch (_: Exception) {}
            val pending = pendingTtsSpeech
            pendingTtsSpeech = null
            if (pending != null) {
                val ok = speakTextWithStyle(pending.text, pending.lang, pending.pitch, pending.rate, pending.gender)
                if (!ok) {
                    activity.notifyTtsPlaybackDone()
                }
            }
        } else {
            isTtsInitialized = false
            val hadPending = pendingTtsSpeech != null
            pendingTtsSpeech = null
            if (hadPending) {
                activity.notifyTtsPlaybackDone()
            }
        }
    }

    @JavascriptInterface
    fun speakText(text: String?, lang: String?): Boolean {
        return speakTextWithStyle(text, lang, 1.0f, 1.0f, "auto")
    }

    @JavascriptInterface
    fun speakTextWithStyle(text: String?, lang: String?, pitch: Float, rate: Float, voiceGender: String?): Boolean {
        if (text.isNullOrBlank()) return false
        val stripped = text
            .replace(Regex("[\\x{1F000}-\\x{1FAFF}\\x{2600}-\\x{27BF}\\x{2300}-\\x{23FF}\\x{2B00}-\\x{2BFF}\\uFE0E\\uFE0F\\u200D\\u20E3]+"), " ")
            .replace(Regex("[\\uD83C-\\uDBFF][\\uDC00-\\uDFFF]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (stripped.isBlank()) return false
        var engine = tts
        if (engine == null) {
            try {
                engine = TextToSpeech(activity.applicationContext, this)
                tts = engine
            } catch (_: Exception) {}
        }
        if (engine == null) return false
        if (!isTtsInitialized) {
            pendingTtsSpeech = PendingTtsSpeech(stripped, lang, pitch, rate, voiceGender)
            return true
        }
        pendingTtsSpeech = null
        return try {
            val hasBengaliScript = Regex("[\\u0980-\\u09FF]").containsMatchIn(stripped)
            val hasDevanagari = Regex("[\\u0900-\\u097F]").containsMatchIn(stripped)
            val hasArabic = Regex("[\\u0600-\\u06FF]").containsMatchIn(stripped)
            val cleanLang = lang?.trim()?.lowercase(Locale.US) ?: ""
            val candidates = when {
                hasBengaliScript || cleanLang.startsWith("bn") -> listOf(Locale("bn", "BD"), Locale("bn", "IN"), Locale("bn"), Locale.US, Locale.ENGLISH)
                hasDevanagari || cleanLang.startsWith("hi") -> listOf(Locale("hi", "IN"), Locale("hi"), Locale.US, Locale.ENGLISH)
                hasArabic || cleanLang.startsWith("ar") -> listOf(Locale("ar", "SA"), Locale("ar"), Locale.US, Locale.ENGLISH)
                cleanLang.contains("-") -> {
                    val parts = cleanLang.split("-", limit = 2)
                    listOf(Locale(parts[0], parts[1].uppercase(Locale.US)), Locale.US, Locale.ENGLISH)
                }
                else -> listOf(Locale.US, Locale.UK, Locale.ENGLISH)
            }

            var chosenLocale: Locale? = null
            for (loc in candidates) {
                val res = engine.setLanguage(loc)
                if (res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED) {
                    chosenLocale = loc
                    break
                }
            }
            if (chosenLocale == null) {
                engine.setLanguage(Locale.getDefault())
            }
            val finalLocale: Locale = chosenLocale ?: Locale.getDefault()

            try {
                engine.setPitch(pitch.coerceIn(0.65f, 1.45f))
                engine.setSpeechRate(rate.coerceIn(0.7f, 1.4f))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && !voiceGender.isNullOrBlank() && voiceGender != "auto") {
                    val wantedLang = finalLocale.language.lowercase(Locale.US)
                    val matchingVoices = engine.voices?.filter {
                        it.locale != null && it.locale.language.equals(wantedLang, ignoreCase = true)
                    }.orEmpty()
                    if (matchingVoices.isNotEmpty()) {
                        val maleHints = listOf("male", "pradeep", "bashkar", "man", "guy", "david", "daniel", "-bdm", "-inm", "-usm")
                        val femaleHints = listOf("female", "nabanita", "tanishaa", "woman", "aria", "samantha", "zira", "-bdf", "-inf", "-usf")
                        val preferred = matchingVoices.firstOrNull { v ->
                            val n = v.name.lowercase(Locale.US)
                            if (voiceGender.equals("male", ignoreCase = true)) maleHints.any { n.contains(it) }
                            else femaleHints.any { n.contains(it) }
                        }
                        if (preferred != null) engine.voice = preferred
                    }
                }
            } catch (_: Exception) {}

            val speakResult = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                engine.speak(stripped, TextToSpeech.QUEUE_FLUSH, null, "AloAiTts_${System.currentTimeMillis()}")
            } else {
                @Suppress("DEPRECATION")
                engine.speak(stripped, TextToSpeech.QUEUE_FLUSH, null)
            }
            speakResult == TextToSpeech.SUCCESS
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun stopSpeech() {
        pendingTtsSpeech = null
        try {
            tts?.stop()
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun isSpeaking(): Boolean {
        return try {
            tts?.isSpeaking == true
        } catch (_: Exception) {
            false
        }
    }

    fun destroy() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {}
        tts = null
        isTtsInitialized = false
    }

    @JavascriptInterface
    fun vibrate(milliseconds: Long) {
        val clampedMs = milliseconds.coerceIn(5L, 250L)
        try {
            val vibrator = getVibratorService()
            if (vibrator != null && vibrator.hasVibrator()) {
                when {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
                        val effectId = when {
                            clampedMs <= 15L -> VibrationEffect.EFFECT_TICK
                            clampedMs <= 40L -> VibrationEffect.EFFECT_CLICK
                            else -> VibrationEffect.EFFECT_HEAVY_CLICK
                        }
                        val amp = when {
                            clampedMs <= 15L -> 95
                            clampedMs <= 40L -> 160
                            else -> 220
                        }
                        vibratePredefinedOrOneShot(vibrator, effectId, clampedMs, amp)
                    }
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> {
                        vibrator.vibrate(VibrationEffect.createOneShot(clampedMs, VibrationEffect.DEFAULT_AMPLITUDE))
                    }
                    else -> {
                        @Suppress("DEPRECATION")
                        vibrator.vibrate(clampedMs)
                    }
                }
            }
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun haptic(type: String?) {
        try {
            val vibrator = getVibratorService() ?: return
            if (!vibrator.hasVibrator()) return
            val kind = type?.trim()?.lowercase(Locale.US) ?: "light"

            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
                    val (effectId, fallbackMs, fallbackAmp) = when (kind) {
                        "light", "tick", "selection" -> Triple(VibrationEffect.EFFECT_TICK, 10L, 95)
                        "heavy", "error" -> Triple(VibrationEffect.EFFECT_HEAVY_CLICK, 28L, 220)
                        "medium", "confirm", "success" -> Triple(VibrationEffect.EFFECT_CLICK, 18L, 160)
                        else -> Triple(VibrationEffect.EFFECT_CLICK, 14L, 130)
                    }
                    vibratePredefinedOrOneShot(vibrator, effectId, fallbackMs, fallbackAmp)
                }
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> {
                    val ms = when (kind) {
                        "light", "tick", "selection" -> 10L
                        "heavy", "error" -> 28L
                        else -> 18L
                    }
                    vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                }
                else -> {
                    val ms = if (kind == "heavy" || kind == "error") 28L else 14L
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(ms)
                }
            }
        } catch (_: Exception) {}
    }

    private fun vibratePredefinedOrOneShot(vibrator: Vibrator, effectId: Int, fallbackMs: Long, fallbackAmp: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val supported = try {
                vibrator.areAllEffectsSupported(effectId) == Vibrator.VIBRATION_EFFECT_SUPPORT_YES
            } catch (_: Exception) {
                false
            }
            if (supported) {
                vibrator.vibrate(VibrationEffect.createPredefined(effectId))
            } else {
                vibrator.vibrate(VibrationEffect.createOneShot(fallbackMs, fallbackAmp.coerceIn(1, 255)))
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            vibrator.vibrate(VibrationEffect.createPredefined(effectId))
        }
    }

    private fun getVibratorService(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            vibratorManager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    @JavascriptInterface
    fun showToast(message: String?) {
        if (!message.isNullOrBlank()) {
            activity.runOnUiThread {
                Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun shareText(text: String?) {
        if (!text.isNullOrBlank()) {
            activity.runOnUiThread {
                try {
                    val sendIntent = Intent().apply {
                        action = Intent.ACTION_SEND
                        putExtra(Intent.EXTRA_TEXT, text)
                        type = "text/plain"
                    }
                    val shareIntent = Intent.createChooser(sendIntent, "Share via Alora")
                    activity.startActivity(shareIntent)
                } catch (_: Exception) {}
            }
        }
    }

    @JavascriptInterface
    fun downloadImage(url: String?, filename: String?) {
        if (url.isNullOrBlank()) return
        activity.runOnUiThread {
            try {
                val uri = Uri.parse(url)
                if (uri.scheme?.equals("https", ignoreCase = true) != true) {
                    Toast.makeText(activity, activity.getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
                    return@runOnUiThread
                }
                val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager ?: return@runOnUiThread
                val rawName = filename?.takeIf { it.isNotBlank() } ?: "Alora_Image_${System.currentTimeMillis()}.png"
                val targetName = File(rawName).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val request = DownloadManager.Request(uri)
                    .setTitle(targetName)
                    .setDescription("Alora Image Download")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, targetName)
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(true)
                dm.enqueue(request)
                Toast.makeText(activity, activity.getString(R.string.download_started), Toast.LENGTH_SHORT).show()
            } catch (_: Exception) {
                Toast.makeText(activity, activity.getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun reload() {
        activity.runOnUiThread { activity.reloadWebView() }
    }

    @JavascriptInterface
    fun logout() {
        activity.runOnUiThread {
            activity.logoutAndGoToAuth()
        }
    }

    @JavascriptInterface
    fun saveAuth(token: String?, name: String?, email: String?, plan: String?) {
        if (!token.isNullOrBlank()) {
            val prefs = activity.getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
            prefs.edit()
                .putString("auth_token", token)
                .putString("user_name", name ?: "")
                .putString("user_email", email ?: "")
                .putString("user_plan", plan ?: "Free")
                .apply()
        }
    }

    @JavascriptInterface
    fun clearAuth() {
        val prefs = activity.getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
    }

    @JavascriptInterface
    fun setSystemBarsTheme(isLight: Boolean, bgHex: String?) {
        activity.applySystemBarsTheme(isLight, bgHex)
    }

    @JavascriptInterface
    fun getAuthToken(): String? {
        val prefs = activity.getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
        return prefs.getString("auth_token", null)
    }

    @JavascriptInterface
    fun getUserName(): String? {
        val prefs = activity.getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
        return prefs.getString("user_name", null)
    }

    @JavascriptInterface
    fun getUserEmail(): String? {
        val prefs = activity.getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
        return prefs.getString("user_email", null)
    }

    @JavascriptInterface
    fun getUserPlan(): String? {
        val prefs = activity.getSharedPreferences("AloAiPrefs", Context.MODE_PRIVATE)
        return prefs.getString("user_plan", "Free")
    }

    @JavascriptInterface
    fun canPostNotifications(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return false
            }
        }
        return NotificationManagerCompat.from(activity).areNotificationsEnabled()
    }

    @JavascriptInterface
    fun requestNotificationPermission() {
        activity.runOnUiThread {
            activity.requestPostNotificationPermission()
        }
    }

    @JavascriptInterface
    fun showLocalNotification(title: String?, body: String?) {
        val cleanTitle = title?.trim()?.takeIf { it.isNotEmpty() } ?: "Alora"
        val cleanBody = body?.trim()?.takeIf { it.isNotEmpty() } ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return
            }
        }
        try {
            val tapIntent = Intent(activity, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pendingIntent = PendingIntent.getActivity(activity, 0, tapIntent, flags)
            val notification = NotificationCompat.Builder(activity, MainActivity.NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(cleanTitle)
                .setContentText(cleanBody)
                .setStyle(NotificationCompat.BigTextStyle().bigText(cleanBody))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .build()
            val notifId = (System.currentTimeMillis() and 0x7FFFFFFF).toInt()
            NotificationManagerCompat.from(activity).notify(notifId, notification)
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun startNativeVoice(langTag: String?) {
        activity.startNativeSpeechInput(langTag)
    }

    @JavascriptInterface
    fun stopNativeVoice() {
        activity.stopNativeSpeechInput()
    }

    @JavascriptInterface
    fun startCustomAudio(mode: String?) {
        activity.startCustomAudioCapture(mode)
    }

    @JavascriptInterface
    fun stopCustomAudio(deliver: Boolean) {
        activity.stopCustomAudioCapture(deliver)
    }

    @JavascriptInterface
    fun isNativeApp(): Boolean = true

    @JavascriptInterface
    fun isOnline(): Boolean = activity.isNetworkAvailablePublic()

    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun applyPendingUpdateIfIdle(): Boolean = activity.applyPendingUpdateIfIdleFromJs()

    @JavascriptInterface
    fun hasPendingUpdate(): Boolean = activity.hasPendingLiveUpdate()
}

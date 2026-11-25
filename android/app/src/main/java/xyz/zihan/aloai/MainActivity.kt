package xyz.zihan.aloai

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.view.WindowManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.*
import android.widget.Button
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
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "AloAI"
        const val NOTIFICATION_CHANNEL_ID = "alora_general"
        const val APP_URL = "https://alora.zihan.xyz/"
        const val AUTH_URL = "https://alora.zihan.xyz/login.html"
        private const val BACK_PRESS_INTERVAL = 2000L
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var offlineView: View
    private var hasLoadedPageSuccessfully = false

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var webAppInterface: WebAppInterface? = null

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
        createNotificationChannel()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        )
        enableHighRefreshRate()
        setContentView(R.layout.activity_main)
        applySystemBarsTheme(false, "#212121")

        initViews()
        setupEdgeToEdgeInsets()
        setupWebView()
        setupSwipeRefresh()
        setupBackNavigation()
        checkAndRequestInitialPermissions()

        webView.settings.cacheMode = if (isNetworkAvailable()) {
            WebSettings.LOAD_DEFAULT
        } else {
            WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        val initialUrl = extractTrustedDeepLink(intent) ?: APP_URL
        webView.loadUrl(initialUrl)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val deepLink = extractTrustedDeepLink(intent)
        if (!deepLink.isNullOrBlank()) {
            webView.loadUrl(deepLink)
        }
    }

    private fun isTrustedHost(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        val h = host.lowercase(Locale.US)
        return h == "alora.zihan.xyz" || h.endsWith(".alora.zihan.xyz") ||
               h == "ai.zihan.xyz" || h.endsWith(".ai.zihan.xyz")
    }

    private fun extractTrustedDeepLink(intent: Intent?): String? {
        val data = intent?.data ?: return null
        val scheme = data.scheme?.lowercase(Locale.US) ?: return null
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
                    Color.parseColor(bgHex ?: if (isLight) "#FFFFFF" else "#212121")
                } catch (_: Exception) {
                    if (isLight) Color.WHITE else Color.parseColor("#212121")
                }
                findViewById<View>(R.id.mainRoot)?.setBackgroundColor(parsed)
                if (::webView.isInitialized) {
                    webView.setBackgroundColor(parsed)
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
            val maxMode = currentDisplay?.supportedModes?.maxByOrNull { it.refreshRate }
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
        offlineView = findViewById(R.id.offlineView)

        findViewById<Button>(R.id.btnRetry).setOnClickListener { retryLoading() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.setBackgroundColor(Color.parseColor("#212121"))
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
        }

        val wai = WebAppInterface(this)
        webAppInterface = wai
        webView.addJavascriptInterface(wai, "AloAndroid")
        webView.addJavascriptInterface(wai, "AloAI")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
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

            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, "[WebView Console] ${consoleMessage.message()} -- From line ${consoleMessage.lineNumber()} of ${consoleMessage.sourceId()}")
                }
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
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
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "Could not launch external URL: $uri", e)
                    true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
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

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false

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
                            var bg = (meta && meta.content) || '#212121';
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

                if (url != null && url != "about:blank" && !url.startsWith("data:")) {
                    hasLoadedPageSuccessfully = true
                    showOfflineView(false)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) {
                    Log.e(TAG, "Page load error: ${error.description}")
                    if (!hasLoadedPageSuccessfully) {
                        showOfflineView(true)
                    } else {
                        Toast.makeText(this@MainActivity, getString(R.string.error_offline_title), Toast.LENGTH_SHORT).show()
                    }
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

        swipeRefresh.setOnRefreshListener {
            if (isNetworkAvailable()) {
                webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
                webView.reload()
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
                            webView.goBack()
                        } else {
                            val currentTime = System.currentTimeMillis()
                            if (currentTime - lastBackPressTime < BACK_PRESS_INTERVAL) {
                                finish()
                            } else {
                                lastBackPressTime = currentTime
                                Toast.makeText(this@MainActivity, getString(R.string.exit_prompt), Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                }
            }
        })
    }

    private fun retryLoading() {
        showOfflineView(false)
        webView.settings.cacheMode = if (isNetworkAvailable()) {
            WebSettings.LOAD_DEFAULT
        } else {
            WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        val current = webView.url
        val targetUrl = if (!current.isNullOrBlank() && current != "about:blank" && !current.startsWith("data:")) current else APP_URL
        webView.loadUrl(targetUrl)
    }

    private fun showOfflineView(show: Boolean) {
        offlineView.visibility = if (show) View.VISIBLE else View.GONE
        webView.visibility = if (show) View.GONE else View.VISIBLE
        swipeRefresh.isEnabled = show
        if (show) {
            swipeRefresh.isRefreshing = false
        }
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
            val ext = if (mimeType != null && mimeType.contains("png")) ".png" else ".jpg"
            val filename = "Alora_$timeStamp$ext"

            val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val file = File(downloadsDir, filename)

            FileOutputStream(file).use { fos ->
                fos.write(bytes)
                fos.flush()
            }

            Toast.makeText(this, "${getString(R.string.download_complete)}: $filename", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.e(TAG, "Error saving data URI", e)
            Toast.makeText(this, getString(R.string.save_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun checkAndRequestInitialPermissions() {
        val neededPermissions = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.CAMERA)
        }
        if (neededPermissions.isNotEmpty()) {
            permissionLauncher.launch(neededPermissions.toTypedArray())
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

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
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

            webView.post {
                webView.loadUrl(APP_URL)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error logging out", e)
        }
    }

    override fun onDestroy() {
        webAppInterface?.destroy()
        webView.destroy()
        super.onDestroy()
    }
}

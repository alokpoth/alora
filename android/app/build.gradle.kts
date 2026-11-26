import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "xyz.zihan.aloai"
    compileSdk = 35

    defaultConfig {
        applicationId = "xyz.zihan.aloai"
        minSdk = 24
        targetSdk = 35
        // Version format strictly pinned to 1.0.0.XX (increment only XX unless explicitly authorized)
        versionCode = 22
        versionName = "1.0.0.22"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            val ksPath = keystoreProps.getProperty("storeFile")
                ?: System.getenv("ANDROID_KEYSTORE_PATH")
                ?: "alora-release.jks"
            val resolvedKs = rootProject.file(ksPath).takeIf { it.exists() } ?: file(ksPath)
            storeFile = resolvedKs
            storePassword = keystoreProps.getProperty("storePassword")
                ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
                ?: ""
            keyAlias = keystoreProps.getProperty("keyAlias")
                ?: System.getenv("ANDROID_KEY_ALIAS")
                ?: "zihanfakir"
            keyPassword = keystoreProps.getProperty("keyPassword")
                ?: System.getenv("ANDROID_KEY_PASSWORD")
                ?: ""
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = false
        buildConfig = true
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    
    // Compose
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    
    // Retrofit & Coroutines for Network
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    val webRoot = rootProject.projectDir.parentFile
    from(webRoot) {
        include(
            "index.html",
            "login.html",
            "plans.html",
            "checkout.html",
            "account.html",
            "profile.html",
            "security.html",
            "personalization.html",
            "help.html",
            "redeem.html",
            "download.html",
            "404.html",
            "manifest.json",
            "favicon.ico",
            "favicon.svg",
            "favicon.png",
            "favicon-32x32.png",
            "favicon-16x16.png",
            "apple-touch-icon.png",
            "app_logo.png",
            "app_logo_*.png",
            "logo_*.png",
            "alokpath_*.png",
            "alokpath_*.svg",
            "logo/**",
            "avatars/**",
            "vendor/**"
        )
    }
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild").configure {
    dependsOn(syncWebAssets)
}

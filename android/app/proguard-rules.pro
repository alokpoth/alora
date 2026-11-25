# ProGuard rules for Alora AI
-keepattributes JavascriptInterface,Annotation,Signature,InnerClasses,EnclosingMethod
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class xyz.zihan.aloai.WebAppInterface { *; }
-keep class xyz.zihan.aloai.BuildConfig { *; }

# Keep all API request & response data classes intact
-keep class xyz.zihan.aloai.api.** { *; }
-keepclassmembers class xyz.zihan.aloai.api.** { *; }

# Keep Gson annotations and classes
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class com.google.gson.** { *; }

# Keep Retrofit & OkHttp cleanly under R8
-keep class retrofit2.** { *; }
-keepclasseswithmembers class * {
    @retrofit2.http.* <methods>;
}
-keep class okhttp3.** { *; }
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

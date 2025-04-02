plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.jetbrains.kotlin.android)
    alias(libs.plugins.serialization)

}

android {
    namespace = "com.nparashuram.dicomviewer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nparashuram.dicomviewer"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    flavorDimensions += "device"
    productFlavors {
        create("mobile") { dimension = "device" }
        create("quest") {
            dimension = "device"
            minSdk = 28
        }
    }

    buildTypes {
        debug {
            resValue("string", "clear_text_config", "true")
        }
        release {
            isMinifyEnabled = false
            resValue("string", "clear_text_config", "false")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.5"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

val questDebugImplementation: Configuration by configurations.creating

dependencies {

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.okhttp)
    implementation(libs.logging.interceptor)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.coil.base)

    // Quest MetaSpatial SDK dependencies
    "questImplementation"(libs.meta.spatial.sdk)
    "questImplementation"(libs.meta.spatial.sdk.animation)
    "questImplementation"(libs.meta.spatial.sdk.compose)
    "questImplementation"(libs.meta.spatial.sdk.physics)
    "questImplementation"(libs.meta.spatial.sdk.toolkit)
    "questImplementation"(libs.meta.spatial.sdk.vrsdk)
    "questImplementation"(libs.meta.spatial.sdk.mruk)
    "questDebugImplementation"(libs.meta.spatial.sdk.ovrmetrics)
    "questDebugImplementation"(libs.meta.spatial.sdk.castinputforward)
    "questDebugImplementation"(libs.meta.spatial.sdk.hotreload)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.ui.test.junit4)
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)
}

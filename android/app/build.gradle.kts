import java.util.Properties

plugins { alias(libs.plugins.android.application) }
// Release signing comes from a private properties file outside the repository
// (storeFile, storePassword, keyAlias, keyPassword), passed as -PlumendockSigning=<path>.
// Without it the release APK is built unsigned.
val releaseSigning = providers.gradleProperty("lumendockSigning").orNull?.let { path ->
    Properties().apply { file(path).inputStream().use { load(it) } }
}
val diagnosticUi = providers.gradleProperty("diagnosticUi").map { it.toBooleanStrict() }.orElse(false)
val dashboardAssets = if (diagnosticUi.get()) rootProject.file("diagnostic") else rootProject.file("../dashboard/dist")
android {
    namespace = "com.phonemonitor"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "com.phonemonitor"
        minSdk = 29
        targetSdk = 36
        versionCode = 110
        versionName = "1.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets {
        getByName("main").assets.directories.add(dashboardAssets.path)
        getByName("test").resources.directories.add("../../packages/protocol/fixtures")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    signingConfigs {
        if (releaseSigning != null) create("release") {
            storeFile = file(releaseSigning.getProperty("storeFile"))
            storePassword = releaseSigning.getProperty("storePassword")
            keyAlias = releaseSigning.getProperty("keyAlias")
            keyPassword = releaseSigning.getProperty("keyPassword")
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    lint { abortOnError = true }
}
val verifyDashboardAssets = tasks.register("verifyDashboardAssets") {
    inputs.files(fileTree(dashboardAssets))
    doLast {
        check(dashboardAssets.resolve("index.html").isFile) {
            "Dashboard bundle missing: build dashboard/dist first, or explicitly use -PdiagnosticUi=true for a diagnostic APK."
        }
    }
}
tasks.configureEach { if (name.matches(Regex("merge.*Assets"))) dependsOn(verifyDashboardAssets) }
dependencies {
    implementation(libs.webkit)
    implementation(libs.gson)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.junit)
}

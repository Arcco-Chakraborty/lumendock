plugins { alias(libs.plugins.android.application) }
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
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets {
        getByName("main").assets.directories.add(dashboardAssets.path)
        getByName("test").resources.directories.add("../../packages/protocol/fixtures")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
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

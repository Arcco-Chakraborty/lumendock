# A1 fix round1 evidence checkpoint

Source commit:38cf1bc9f924ca86a8156a1d0d1d37772164d84b; prior reviewed source4a88b40. Native paths were unchanged between4a88b40 andc7f1f44; the c7f1f44..38cf1bc review package is the exact native fix. External Sonnet completed and committed this fix while original worker turns were interrupted. Independent Astra-high re-review remains required.

Shared PROGRESS reports7 newly failing lifecycle regressions before repair and19/19 JVM tests plus lint0errors after repair. Reported command from HANDOFF: JAVA_HOME=user-local-jdk17 ANDROID_HOME=user-local-sdk ./gradlew --offline :app:testDebugUnitTest :app:lintDebug from android/. Coordinator did not rerun the suite: it inspected the existing XML results below for concrete evidence. Instrumentation execution and actual device lifecycle remain unrun.

Fix adds explicit NativeSession OS approval ownership, inactive renderer scopes, stopped replacement WebView pause, and LifecycleReplyDelivery main-queue epoch validation. Reviewer must assess these actual changes rather than trust this description.

## Existing JVM result artifacts inspected

- TEST-com.phonemonitor.ActivityLifecycleRegressionTest.xml: tests=5, failures=0, errors=0, timestamp=2026-10-15T06:19:50.683Z
- TEST-com.phonemonitor.AssetPolicyTest.xml: tests=1, failures=0, errors=0, timestamp=2026-10-15T06:19:50.687Z
- TEST-com.phonemonitor.BridgeRouterTest.xml: tests=6, failures=0, errors=0, timestamp=2026-10-15T06:19:50.590Z
- TEST-com.phonemonitor.LifecycleReplyDeliveryTest.xml: tests=3, failures=0, errors=0, timestamp=2026-10-15T06:19:50.691Z
- TEST-com.phonemonitor.SessionLifecycleTest.xml: tests=4, failures=0, errors=0, timestamp=2026-10-15T06:19:50.696Z

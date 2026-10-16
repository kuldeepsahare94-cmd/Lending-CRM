// After "npx cap add android": the few things the Android project needs for iCRM.
// Safe to run more than once. Used by the GitHub build (.github/workflows/android-app.yml).
//
//   - the version (versionName from package.json, versionCode from BUILD_NUMBER)
//   - the "on duty" notification: its channel name, icon and colour
//   - signing with your key, when the build is given one (ICRM_KEYSTORE…)
//   - iCRM's own Java code (android-src/): the phone's call history and call recordings
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = path.join(root, 'android', 'app');
if (!fs.existsSync(app)) { console.error('No android/app folder: run "npx cap add android" first.'); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1. version
const gradleFile = path.join(app, 'build.gradle');
let gradle = fs.readFileSync(gradleFile, 'utf8');
const code = Math.max(1, Number(process.env.BUILD_NUMBER) || 1);
gradle = gradle.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);

// 2. signing (only when a key is given; without one the build makes a debug APK only)
const ks = process.env.ICRM_KEYSTORE;
if (ks && fs.existsSync(ks) && !gradle.includes('signingConfigs {')) {
  gradle = gradle.replace(/buildTypes \{/, `signingConfigs {
        release {
            storeFile file(System.getenv("ICRM_KEYSTORE"))
            storePassword System.getenv("ICRM_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ICRM_KEY_ALIAS")
            keyPassword System.getenv("ICRM_KEY_PASSWORD")
        }
    }
    buildTypes {`);
  gradle = gradle.replace(/release \{\n(\s*)minifyEnabled false/, 'release {\n$1signingConfig signingConfigs.release\n$1minifyEnabled false');
  console.log('signing: the release build is signed with your key');
}
fs.writeFileSync(gradleFile, gradle);

// 3. the notification shown while on duty (Android needs it to follow the route with the screen off)
const stringsFile = path.join(app, 'src', 'main', 'res', 'values', 'strings.xml');
let strings = fs.readFileSync(stringsFile, 'utf8');
const add = {
  capacitor_background_geolocation_notification_channel_name: 'On duty (route)',
  capacitor_background_geolocation_notification_icon: 'drawable/ic_tracking',
  capacitor_background_geolocation_notification_color: '#3B5BFF',
};
for (const [k, v] of Object.entries(add)) {
  if (!strings.includes(`name="${k}"`)) strings = strings.replace('</resources>', `    <string name="${k}">${v}</string>\n</resources>`);
}
fs.writeFileSync(stringsFile, strings);
const res = path.join(root, 'android-res');
if (fs.existsSync(res)) {
  for (const dir of fs.readdirSync(res)) {
    const to = path.join(app, 'src', 'main', 'res', dir);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(path.join(res, dir))) fs.copyFileSync(path.join(res, dir, f), path.join(to, f));
  }
}

// 4. https only (the CRM is on https); a plain http address is refused by Android
const manifestFile = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestFile, 'utf8');
if (!manifest.includes('usesCleartextTraffic')) manifest = manifest.replace('<application', '<application\n        android:usesCleartextTraffic="false"');
// 5. the sign-in and the work waiting to be sent stay on this phone (not in a Google backup)
manifest = manifest.replace('android:allowBackup="true"', 'android:allowBackup="false"');
// 6. the phone's call history (start, length, answered) and the dialer's call recordings - read only
const perms = [
  'android.permission.READ_CALL_LOG',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.RECORD_AUDIO',
  // (v1.3) recording a meeting in the app: the web view's microphone needs this too
  'android.permission.MODIFY_AUDIO_SETTINGS',
  // (v1.3) reminders at an exact time (punch in / out)
  'android.permission.SCHEDULE_EXACT_ALARM',
];
for (const p of perms) {
  if (!manifest.includes(`"${p}"`)) manifest = manifest.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
}
fs.writeFileSync(manifestFile, manifest);

// 7. copy iCRM's Java code (CallLogPlugin + MainActivity that switches it on)
const javaSrc = path.join(root, 'android-src');
const copyJava = (from, to) => {
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, f.name), b = path.join(to, f.name);
    if (f.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyJava(a, b); } else fs.copyFileSync(a, b);
  }
};
if (fs.existsSync(javaSrc)) {
  const javaDir = path.join(app, 'src', 'main', 'java');
  fs.mkdirSync(javaDir, { recursive: true });
  copyJava(javaSrc, javaDir);
  console.log('java: CallLogPlugin added');
}

console.log(`android ready: iCRM ${pkg.version} (${code})`);

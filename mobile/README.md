# iCRM — the Android app

One app for every customer company. The app asks for the company's CRM
address once, then the person signs in with their CRM user name and
password. It shows what that company's CRM has: its modules, its fields,
its rules (Settings → Field force).

## What it does

- **Attendance**: punch in / punch out with GPS place, and a selfie when the
  company asks for one. Late and "left early" are marked on the web.
- **Route and km**: from punch in to punch out the route is recorded, also
  with the screen off (a notification "iCRM — on duty" stays while it runs).
  Km are counted on the server (bad GPS points, jumps and fake-location apps
  are left out).
- **Visits**: check in at a customer (from "near you" or by search, or at a
  meeting), photos and files, outcome, notes, next step, check out. A meeting
  is completed with the visit's notes.
- **Works without internet**: punch, visits, photos and expenses wait on the
  phone and are sent when the internet is back. Searching and opening
  records need the internet.
- **Customers and leads**: lists with search, details, add and change (the
  company's own form fields), WhatsApp, directions in Google Maps, "the customer is here".
- **Calls** (version 1.1): tap Call → the phone's dialer → back in the app, the
  phone's call history gives the real start, end, length and whether it was
  answered. With "auto log" the call is saved by itself; the person can add the
  outcome, a remark (typed or spoken), the lead's status and a follow-up
  (This evening / Tomorrow / In 3 days / Next week / Pick), and send a WhatsApp
  message. Works offline (outbox).
- **The phone's calls**: calls made or missed outside the app with numbers that
  are in the CRM are found and saved; Home shows "Call back" for missed calls
  from customers and the day's calls against the target; "Phone calls" lists the
  phone's recent calls with the CRM's names and "Lead" for an unknown number.
  Calls with numbers that are not in the CRM are never saved.
- **Call recordings**: on phones whose own dialer records calls (Samsung,
  Xiaomi/Redmi/POCO, Oppo, Vivo, Realme, OnePlus — "Record calls automatically"
  in the phone's Phone app), the recording is found after the call and saved with
  it. Phones with the Google Phone app (Pixel, Motorola, Nokia…) do not keep a
  recording file other apps can read: use the telephony (MCube) for those.
- **Speak instead of typing**: a mic on every notes box (English, हिंदी, मराठी),
  with the phone's own speech recognition (free).
- **New version**: when Settings → Field force → Calls & app has a newer version,
  Home shows "A new version of iCRM is ready" with the download link.
- **Orders**: a quotation in a few taps — products with photos, + / − for the
  quantity; the CRM works out the tax and the total.
- **Meetings, calls, tasks, subscriptions, deals, contacts**: lists and details;
  a task can be marked done.
- **Expenses**: add one with the bill photo (also offline). Claims and
  approvals are on the web.
- **Near me**: saved customers around you, on a map, nearest first.
- **Team** (managers): where the team is now, and each person's day route with
  km between stops.

## Making the APK (no Android Studio needed)

The app is built on GitHub, for free:

1. Upload the `mobile` folder to the same GitHub repository as `backend` and
   `frontend` (not `node_modules`, `dist` or `android` — they are made by the build).
2. Create the build file once: in GitHub, **Add file → Create new file**, name
   it exactly `.github/workflows/android-app.yml`, paste the content of
   `github-workflow/android-app.yml` from the zip, and commit.
3. Open **Actions → Android app**. It runs by itself after a change in `mobile`
   (or press **Run workflow**). It takes about 10 minutes.
4. Open the finished run → **Artifacts → icrm-android** → download → unzip →
   `iCRM-1.0.0-<n>-debug.apk`.

Install on a phone: send the APK to the phone (WhatsApp / Drive), open it,
allow "Install unknown apps" once.

### A signed app (for the Play Store, or to update without uninstalling)

Make a key once (on any computer with Java):

    keytool -genkey -v -keystore icrm.jks -alias icrm -keyalg RSA -keysize 2048 -validity 10000

Keep `icrm.jks` and its passwords safe — every later version must be signed
with the same key. In GitHub: **Settings → Secrets and variables → Actions →
New repository secret**:

| Name | Value |
|---|---|
| `ICRM_KEYSTORE_BASE64` | the key file as base64 (`base64 -w0 icrm.jks`) |
| `ICRM_KEYSTORE_PASSWORD` | the key store password |
| `ICRM_KEY_ALIAS` | `icrm` |
| `ICRM_KEY_PASSWORD` | the key password |

The next build then makes `iCRM-<version>-<n>.apk` (signed) and
`iCRM-<version>-<n>.aab` (for the Play Store).

A debug APK (made without the key) is signed by a new, random key at each build:
Android then refuses to install a newer debug APK over an older one ("App not
installed"). With your key, every new version installs over the old one.

The Play Store asks about the call history: `READ_CALL_LOG` is allowed for a
CRM only with the Permissions Declaration Form (Play Console → App content →
Sensitive permissions; the "enterprise / CRM" use). Installing the APK yourself
(not from the Play Store) needs nothing of this.

The Play Store asks about the location in the background. The app uses a
foreground service with a notification only between punch in and punch out
— that is how to describe it in the Play Console ("Location: shown to the
user with a notification while on duty, for attendance and travel claims").

## First start on a phone

1. Type the CRM address (Settings → Field force on the web shows it, with a copy button).
2. Sign in.
3. Allow **Location** ("While using the app") and **Notifications** when asked;
   at the first call, **Call logs** and **Music and audio** (for the recordings);
   at the first mic tap, the **Microphone**.
4. On Xiaomi / Redmi / Oppo / Vivo / Realme / OnePlus / Samsung: Settings →
   Apps → iCRM → Battery → **No restrictions** (and **Autostart** on Xiaomi),
   or the phone may stop the route when the screen is off. The app's
   **More** tab says the same.

## For developers

    npm install
    npm run dev          # the screens in a browser (phone size), http://localhost:5175
    npm run build
    npx cap add android  # once; then node scripts/android-setup.mjs
    npx cap sync android # after each build; then open android/ in Android Studio

The server must allow the app's address: the CRM server already allows
`https://localhost` (the app inside the phone). Testing in a browser on
another address: add it to `FRONTEND_URL` on the server (comma separated).

iCRM's own Android code (the phone's call history and recordings) is in
`android-src/` (a Capacitor plugin, `CallLog`); `scripts/android-setup.mjs` copies it
into the Android project and adds its permissions. In a browser the app uses a
stand-in when `window.__icrmCallLog` is set (tests).

Built with React, Vite, Capacitor 7, Leaflet (OpenStreetMap). App id
`com.ipercepts.icrm`.

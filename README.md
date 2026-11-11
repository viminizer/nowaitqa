# nowait-qa

Run mobile app tests on real phones with Appium, from one shared queue.
Any free phone takes the next test, so fast phones never wait for slow ones.
In each run, phones take the longest tests first (by their recent times), so a run does not end
with one phone on a long test while the others wait.

Status: in development.

The repository includes a [TypeScript CLI](cli/README.md) for humans and external agents.
Run `pnpm --silent nowait capabilities --json` to discover commands and request schemas.
It uses the same server operations as the dashboard, with structured results and a dedicated CLI token.

## Inspiration

Nowait QA was inspired by the MUSINSA Automation QE team's article
[빠른 기기가 왜 기다려야 하지?](https://techblog.musinsa.com/빠른-기기가-왜-기다려야-하지-a0533ee53dd2)
(“Why should fast devices wait?”) by 정다정, about their test automation Framework 3.0.
Its shared scenario queue and centralized device management inspired this project's core design.

## Local setup

```bash
pnpm install
docker compose up -d   # Postgres
```

## Server

Settings come from environment variables. `server/env.example` lists them; the ones with a value
there have that default. Set at least the database, the two tokens and the dashboard password:

```bash
export DATABASE_URL=postgres://nowait:nowait@localhost:5432/nowait
export RUNNER_TOKEN=<random, 16+ characters> TRIGGER_TOKEN=<another one>
export DASHBOARD_PASSWORD=<another one>
pnpm --filter @nowait/server dev
```

Every request needs `Authorization: Bearer <token>`, except `GET /health` and the dashboard.
There are two tokens:

- `RUNNER_TOKEN`: the runner. It can call every route.
- `TRIGGER_TOKEN`: Jenkins. It can start/read runs and grouped launches (`/runs`, `/launches`),
  read manifests and scenario history. It cannot lease work or report results.

| Route                      | Who calls it | What it does                                                       |
| -------------------------- | ------------ | ------------------------------------------------------------------ |
| `POST /runs`               | Jenkins      | Start a run: puts every scenario for the platform in the queue     |
| `GET /runs/:id`            | anyone       | Run status, and each scenario as pending / passed / flaky / failed |
| `PUT /devices`             | you          | Add or change a phone (runner token)                               |
| `GET /devices?host=`       | runner       | The phones plugged into one machine                                |
| `POST /devices/contact`    | runner       | Report that one device worker is still connected                   |
| `PUT /catalog`             | runner       | Send its scenario list and their git commit (at startup)           |
| `GET /catalog/revisions`   | runner       | Page revisions referenced by running work or unconfirmed cleanup   |
| `POST /lease`              | runner       | Take the next scenario. Waits up to 30s if there is none           |
| `POST /heartbeat`          | runner       | Keep a lease alive while a scenario runs                           |
| `POST /release`            | runner       | Confirm stopped execution and release a cleanup reservation        |
| `POST /fixtures/register`  | runner       | Journal a scoped fixture before provisioning                       |
| `POST /fixtures/claim`     | runner       | Claim one eligible cleanup with a reservation                      |
| `POST /fixtures/finish`    | runner       | Report verified cleanup and executor termination                   |
| `GET /fixtures`            | runner       | Page pending resources or an attempt's retained history            |
| `POST /fixtures/:id/retry` | runner       | Confirm stopped execution and request cleanup again                |
| `POST /results`            | runner       | Report pass or fail, with a screenshot and a log                   |

A failed scenario runs once more. A lease that is not kept alive runs out, and the scenario goes
back to the queue. A run is stuck when no phone of its platform has taken or finished any work for
`STUCK_RUN_MINUTES` (default 15), for example when no phone is connected. A stuck run fails.
After a restart, the server waits that long before calling a run stuck, and one lease time before
expiring a lease, so phones have time to come back.

When the server detects a disconnect while a runner is waiting for or acquiring work, it cancels
the poll and returns any undelivered lease to the queue without using an attempt. A lease already
sent still expires normally if the runner stops its heartbeats.

## Runner

Runs on the machine the phones are plugged into, next to Appium. One worker per phone: each takes
the next scenario from the server, runs it, reports it, and repeats.

Settings are listed in `runner/env.example`:

```bash
# one Appium server for all phones (UiAutomator2 driver); adb_shell: see below
appium --address 127.0.0.1 --port 4723 --allow-insecure=uiautomator2:adb_shell
export SERVER_URL=http://localhost:3000 RUNNER_TOKEN=<the server's RUNNER_TOKEN> HOST=macmini-1
pnpm --filter @nowait/runner start
```

Appium 3 needs the UiAutomator2 driver 8.x (tested with
`appium driver install uiautomator2@8.7.3`). Driver 9.x needs Appium 4.

`adb_shell` lets the runner turn on Android's `hide_error_dialogs` on each phone. When an app hangs,
Android then closes it instead of showing "isn't responding" over the app under test, which would
fail every scenario on that phone. The setting stays on the phone (undo it with
`adb -s <udid> shell settings put global hide_error_dialogs 0`). Without `adb_shell`, the runner
logs a warning and works as before. `adb_shell` lets anyone who can reach Appium run shell
commands on the phones: keep Appium reachable only from the runner (it listens on all addresses
unless you pass `--address 127.0.0.1`).

For installed virtual devices, use **Phones → Set up a virtual device** below. Physical Android
phones and custom connections can use **Manual device registration** or `PUT /devices` (`host`
must match the runner's `HOST`). New registrations are picked up within a minute.

### Guided virtual-device setup

Start the runner and local Appium on the device machine. Give each runner process a unique
`HOST`; its machine appears on **Phones** even before the first device is registered. Choose
that machine and an installed Android AVD or iOS Simulator by name and runtime. Click
**Register** for a running device or **Start and register** for a stopped one. A single virtual
device works with the ordinary queue; profiles and a second phone are not required.

Discovery never boots devices. An explicit start boots Android headlessly (`-no-window`) or
uses `simctl` without opening Simulator.app. Setup checks Appium and the installed UiAutomator2
or XCUITest driver, waits for boot completion, verifies the selected identity and observed OS
version, reserves ports, and creates a normal registration. **Registered** means setup passed
those checks, not that an app scenario has passed. Start a normal sample run to verify execution.

Prerequisites and runner settings:

- Install the Android SDK tools and an AVD/system image, or Xcode and an iOS Simulator runtime
  on a Mac. Nowait does not install tools, create images, or support physical iPhones.
- `APPIUM_URL` defaults to `http://127.0.0.1:4723`. Guided setup requires a loopback URL on the
  runner's machine and an already running Appium server; include its base path if configured.
  The `appium` executable must describe that server's installed drivers.
- `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) supplies SDK paths. Otherwise `adb` and `emulator`
  must be on PATH. Override with `ADB_BIN`, `EMULATOR_BIN`, `APPIUM_BIN` or `XCRUN_BIN` when
  needed. `ANDROID_AVD_HOME` defaults to `~/.android/avd` for stopped AVD runtime labels;
  actual Android versions are observed after boot.

Inventory refreshes about every minute and supports up to 100 targets per machine. Missing tools,
runtimes, stale inventory and setup failures appear on Phones. An unknown/offline Android
emulator connection blocks unsafe identity guesses. Fix its ADB connection before retrying.
Automatic registration chooses available UiAutomator2 ports from 8200–8299 or WDA/MJPEG pairs
from 8100–8199, and Android console/ADB pairs from 5554–5683. Existing registrations and OS
listeners are checked; server reservations also protect against simultaneous manual additions.
Manually configured Appium URLs, ports, versions and disabled devices are preserved. Conflicting
settings require manual review rather than being overwritten. A serial reused by another AVD
is an identity conflict: stop the affected devices and reconcile their actual IDs with
`PUT /devices` before retrying; a registration associated with another target is never adopted.

Only one setup is open per machine. Progress and cancellation are visible on Phones. Setup has
a seven-minute runner deadline; loss of contact stops owned setup commands before its 60-second
server claim expires. Cancellation or failure **does not shut down an already running or
explicitly started virtual device**. Refresh discovery before retrying. If command termination
or runner ownership is unknown, the server retains an interrupted reservation and never replays
the boot automatically. Stop the old setup runner and confirm its commands ended, then use
**Confirm previous setup stopped**, restart the runner and wait for fresh discovery. This is
separate from scenario/fixture cleanup recovery. Active leases and cleanup holds block setup
for their device; other registered devices continue normal work.

Upgrade the server before runners. Older servers leave manual device execution available but
cannot provide guided setup. Setup history is retained for `ARTIFACT_DAYS`; interrupted holds
remain until explicitly resolved. Real headless Android and iOS Simulator cold boot, automatic
registration and normal sample execution have been verified with public sample apps. Android
required one retry after an initial automation-driver startup timeout; iOS passed all four
sample scenarios. Controlled checks additionally cover cancellation, ownership and failure recovery.

The server gives each registered device at most one leased scenario attempt at a time, even
when duplicate runner processes request work for it. Extra requests wait through the usual
long poll until the current lease is finished, cancelled or expired. Different devices can
still take work concurrently. Upgraded runners also isolate scenario execution and acknowledge
cleanup before a cancelled or expired attempt's device and account become available again.

### Session mode

Set `SESSION_MODE` on the runner, then restart it. The setting applies to every device on that
runner, on both Android and iOS Simulator:

- `reuse` (default): reuse a session within a run and clear app data between scenarios.
- `fresh`: open a new session, clear app data, run one scenario attempt, and close the session
  before reporting its result. This adds session-startup overhead but helps diagnose session-state
  problems. Retries also get a new session.

Failures and health pauses close sessions in both modes. Reuse also starts a new session when
the run or the device's health-reset marker changes. Invalid settings stop the runner at startup.

### Attempt termination and cleanup

Upgrade the server before the runners. Existing runners retain their old lease protocol; restart
all runners on the new version to get the termination and cleanup guarantees. New runners request
`cleanup: true` when leasing and require the server's `cleanupRequired` acknowledgement before
executing scenarios. The migration defaults old rows to no cleanup reservation.

Upgraded runners require macOS or Linux, where owned POSIX process groups can be terminated.
Every scenario attempt runs in a disposable Node process, including when Appium sessions are
reused. Scenario module globals do not persist between attempts. The parent owns lease renewals
and a loopback Appium gateway, so a CPU-bound scenario cannot block heartbeats. Commands check
lease authority before reaching Appium. Parent and scenario connections use this gateway;
scenario code must not create, reload or delete the parent-owned session.

Executor startup has a 30-second limit, separate from `SCENARIO_TIMEOUT_SECONDS` (default 600).
Timeout, cancellation, shutdown or a missed successful-renewal deadline stops new commands and
signals the executor to stop. After 250 ms it is killed if necessary; exit confirmation gets at
most five seconds. Ordinary child tools in the executor's process group are terminated too.
Even a passing executor exits before its result is published, so forgotten timers cannot
continue into the next attempt. Failure evidence is bounded at 15 seconds, and a
session-delete request at 15 seconds. Capture trouble stays diagnostic and preserves the actual
scenario outcome. Passing reuse-mode sessions may remain idle for the next scenario; failed and
fresh-mode sessions are disposed of before reporting the outcome.

Existing two-argument scenarios still work. A third argument gives cooperative cancellation:

```ts
async run(driver, account, { signal }) {
  signal.throwIfAborted()
  // Pass signal to any cancellable backend calls and stop when it is aborted.
}
```

If execution exit or session disposal cannot be confirmed, the worker stops and the server keeps
that attempt's device/account reservation. Cancellation and expiry may already have finished the
run, but its resources remain unavailable. Phones shows **Cleanup required** with the run and
attempt number. Turning a device off and on does not clear this reservation. Retries can use
other eligible devices/accounts, while a run with no available resources still ends under the
normal no-progress timeout.

To recover, verify on the runner/Appium host that the old executor and its commands have stopped
and its session is gone. Interrupted session creation needs particular care: Appium may create a
session after the client disconnected. Confirm that request has settled and remove any orphaned
session for this device; keep the reservation if this cannot be verified. Then acknowledge the
specific attempt, using the runner token:

```bash
curl -X POST "$SERVER_URL/release" \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"queueId":123,"device":"phone-a"}'
```

This request is idempotent. A still-leased row remains busy until completion or expiry. A result's
`cleanupComplete: true` can also release its reservation; the runner sends it only after cleanup
is confirmed. These are trusted-runner acknowledgements, not a sandbox for hostile scenario code.
Do not clear a reservation merely because a run has ended or a process stopped reporting contact.
After a hard runner/host crash, verify descendant processes as well as Appium before acknowledging.
Scenario code must not detach subprocesses from the owned group; such external processes need
explicit cleanup by the scenario author. Already accepted external/backend operations cannot be undone by terminating JavaScript; use
idempotent test-environment operations for those effects.

### Failure origins and recovery

Attempts retain their original error and artifacts, with a phase (`setup`, `scenario`, `cleanup`,
`queue` or `unknown`), failure kind and whether scenario execution began. `GET /runs/:id` includes
the latest origin per scenario; the dashboard's attempt pages retain every physical attempt,
its test-attempt number, recovery decision and successor. Missing progress after worker loss is
**unknown**, not proof that the scenario did not run. Assertion errors, scenario-code errors,
timeouts, lost leases, cancellation and unconfirmed failures remain distinguishable.

New runs record their effective limits when created:

- `MAX_ATTEMPTS` (default2, range1–100): the scenario-attempt budget, including the first attempt.
- `MAX_INFRA_RECOVERIES` (default2, range0–100): separate recoveries per scenario slot.
- `MAX_RUN_INFRA_RECOVERIES` (default10, range0–10000): recoveries shared across the entire run.

Only a connection refusal confirmed by the runner's Appium gateway **before session creation**,
with no scenario execution and confirmed cleanup, qualifies for infrastructure recovery. A new
session is requested through the normal queue; the failed worker keeps its normal error cooldown,
so another eligible worker can take the retry. Other failed attempts, including unknown setup
errors, invalid builds, app crashes, assertions, executor errors, timeouts, lost leases and local
runner interruption, consume the ordinary scenario budget. Dashboard cancellation closes the run
without queuing retries. Existing health pauses remain; there is no message-pattern classifier or
new automatic device healer.

Physical attempt numbers always increase. A pure infrastructure recovery does not consume a test
attempt: a subsequent first test success is `passed`, with its recovery count/history visible in
the dashboard and chat summaries. An application failure followed by success stays `flaky`, even
if infrastructure recovery happened between them. Exhausted recovery is `failed` and never a
successful release result. Each retry records its reason, action, limits and next queue id; the
run-wide allowance is serialized transactionally across concurrent workers. Cleanup reservations
still prevent unsafe device/account reuse.

Upgrade the server before runners to retain progress and origin fields. Older runners/results
remain accepted as unknown origin and use ordinary attempts. Existing runs keep their legacy
total-attempt policy, with no newly privileged infrastructure allowance; their old attempt
counters are preserved by the migration. New response fields have defaults for old servers, and
the existing running/passed/failed run and pending/passed/flaky/failed scenario vocabulary stays.

### Device health

The server checks device health every 15 seconds. It pauses a phone when **three different
scenarios fail on it and later attempts of those same items pass on other phones in the same
run**. A passing result on the suspect phone resets its failure streak. Repeating one scenario
does not count as three different failures, and failures from separate runs are not combined.
This is evidence of suspected device trouble; a device-specific app bug can look the same.

During a pause, already leased work finishes and the phone gets no new work. Other phones can
take its pending fixed-split items. Its next lease request returns **423** with `retryAfterSeconds`
and a `Retry-After` header. The runner closes its Appium session before waiting, then resumes
with a fresh session and failure streak. Old failures and late retries from before recovery
cannot immediately pause it again. New evidence can cause another pause if the problem persists.
Each lease also carries a session-reset marker: work that outlasts the cooldown still gets a
fresh Appium session on its next lease, even if it never received a paused response.

The cooldown is `DEVICE_PAUSE_SECONDS` (default **300**, five minutes). It must be shorter than
`STUCK_RUN_MINUTES`, so a paused phone can resume before a run is considered stuck. The pause
and recovery boundary survive server/runner restarts. The Phones page shows the reason and
resume time; a phone turned off manually stays off after the cooldown ends.

### iOS Simulator

iOS runs use XCUITest on a Mac with Xcode and an installed iOS Simulator runtime. Real iPhones
are not supported yet. Tested with Appium 3.9.0, XCUITest 10.43.1, Xcode 16.4 and iOS 18.5.
Pin the driver: newer releases may require a newer Appium or Xcode.

```bash
appium driver install xcuitest@10.43.1
xcrun simctl list devices available
appium --address 127.0.0.1 --port 4723
```

Use the guided Phones flow to select and boot it without copying a UUID. For manual setup,
register the simulator with `PUT /devices`, using its UUID from `simctl`:
Boot it and wait for readiness with `xcrun simctl bootstatus <uuid> -b` before starting a run;
the first boot of a new simulator may need several minutes to migrate its data.

```json
{
  "name": "iphone-sim-a",
  "platform": "ios",
  "udid": "44DA6CC2-743E-459C-AE56-BC0D4EAE4497",
  "appiumUrl": "http://127.0.0.1:4723",
  "systemPort": 8100,
  "host": "macmini-1"
}
```

For iOS, `systemPort` is the WDA HTTP port and the next port is reserved for MJPEG. Give every
simulator a separate pair (for example 8100/8101 and 8200/8201), with no overlap with other services.
The runner also gives each simulator a separate Xcode build directory on the Appium host under
`/tmp/nowait-wda-<uuid>`.

Start an iOS run with `POST /runs`: `platform: "ios"` and `appBuild` pointing to a **simulator
build** (`.app` on the Appium host, or a URL to a zipped `.app`). An iPhone `.ipa` cannot run in
the simulator. The server never reads that path; Appium installs the build. Android and iOS runs
use the same queue, but each device only takes work for its own platform.

The samples include four iOS scenarios for [Appium's UIKitCatalog](https://github.com/appium/appium-ios/tree/main/packages/uicatalog):
an alert, text entry, a switch and a slider. Build a pinned revision outside this repo:

```bash
git clone https://github.com/appium/appium-ios.git
cd appium-ios
git checkout afeb9cd03af16c7f3cea23633c82d715642c4e58
cd packages/uicatalog
xcodebuild -project UIKitCatalog/UIKitCatalog.xcodeproj -scheme UIKitCatalog \
  -configuration Debug -sdk iphonesimulator -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

Use the absolute path to `build/Build/Products/Debug-iphonesimulator/UIKitCatalog.app` as
`appBuild`. No Apple signing account is needed for this simulator build.

In reuse mode, iOS keeps a session within a run and clears app data before the next scenario.
It also clears data at session startup, including retries. On iOS Simulator this uses
`mobile: clearApp` with the app's bundle ID, then launches the app. It clears the app's data
container; Keychain, privacy permissions and server-side account state are not reset. Verify
the reset behavior for your app. Failed scenarios close the session before another attempt.
Failure evidence includes a PNG screenshot and the last 500 device log lines; if either capture
fails, its error is recorded in the log. An unavailable device log does not fail a scenario.

## Scenarios

Scenarios live in your own folder or repo, not in nowait-qa. Point the runner's `SCENARIOS_DIR` at
it. Without it, the runner uses the samples in `examples/scenarios/`. Use an absolute path: a
relative one is read from the folder the process starts in (`runner/` with `pnpm --filter`).

The folder must be inside a git checkout. At startup the runner sends the server its scenario list
and their git commit. The server never reads test files: a run takes its scenarios from the list
of the commit it names (`commit` in `POST /runs`, short is fine), or from the newest list. Only
runners on that commit take its work.

The runner reads `SCENARIOS_DIR` once, so restart it after you pull. Or let the runner pull:

- `SCENARIOS_REPO`: git URL of your scenarios repo. A private repo uses the machine's git login.
- `SCENARIOS_BRANCH`: default `main`.
- `SCENARIOS_DIR`: required here. An empty folder the runner owns.

Every minute the runner fetches the branch. When it moved, the runner checks the new commit out
into its own folder, runs `pnpm install` if it has a `pnpm-lock.yaml`, and sends the new list to
the server. Pending/running runs retain their exact revisions across later branch updates.

The managed runner pages `GET /catalog/revisions` and restores required commits from its Git
cache or origin, including after restart. Unconfirmed cleanup also retains its revision, even
after the run closes. Lease requests pin their advertised revisions; the selected checkout stays
pinned until executor exit is confirmed, protecting lazy imports. Restoring historical code does
not republish its catalog or change the newest default. Missing commits and failed installs are
reported with their revision in runner logs; ready versions continue serving work. No newer code
is substituted. Upgrade the server first; a missing references endpoint stops managed startup
with an upgrade message. Local folder mode keeps its existing read-once behavior.

Use a separate managed `SCENARIOS_DIR` for each runner process. Ready checkouts contain a
`.nowait-ready` identity marker so restart does not reinstall dependencies underneath retained
execution. An existing unverified checkout with a cleanup hold is preserved and reported
unavailable until cleanup is verified. Do not edit managed checkouts; put scenario changes in
their source repo.

`SCENARIO_CACHE_REVISIONS` defaults to 10 (range 2–100), and `SCENARIO_CACHE_BYTES` to 5 GiB
(minimum 1 MiB). These are admission limits: referenced/pinned code is never deleted to force a
limit. Unreferenced checkouts beyond the current and one warm previous head are reclaimed on
polls, even if the branch did not move; capacity pressure can reclaim the warm head too. A full
cache reports unavailability and delays admitting more versions until references finish or the
budget is increased. Existing ready references can drain after a budget reduction.

Bytes cover the managed directory, including Git objects; pnpm's external shared store is managed
separately. A single fetch/install can temporarily exceed the byte threshold; unsuccessful fresh
checkouts are removed and further fetches pause while the cache remains over budget. This is not
a filesystem quota. Active or uncertain files are retained, and reference-API outages never
authorize eviction. Interrupted installs are retried without replacing a healthy catalog.

One file per scenario, directly in the folder. The file name is the scenario id. Sub-folders
(helpers) are not scenarios. Get the `Scenario` type from `@nowait-qa/sdk`, installed from GitHub
(it is not on npm). It needs pnpm, because npm cannot install a package from a sub-folder of a repo:

```bash
pnpm add -D "github:viminizer/nowaitqa#path:/sdk" webdriverio
```

```ts
// views.checkbox.ts
import type { Scenario } from '@nowait-qa/sdk'

export default {
  id: 'views.checkbox',
  platforms: ['android'],
  async run(driver, account) {
    // drive the app with WebdriverIO; wait for elements, never sleep
  },
} satisfies Scenario
```

Each scenario starts from a fresh app (data cleared). The runner reads the folder at startup, so
restart it after you change the scenarios.

[`examples/scenarios/`](examples/scenarios) is a sample folder to copy. It tests Appium's
[ApiDemos](https://github.com/appium/android-apidemos) app. After copying, delete the
`@nowait-qa/sdk` line from its `package.json` (it points inside this repo), then run the install
command above.

## Benchmark

Runs the same scenarios twice - each phone with a fixed list (the old way), then the shared
queue - and prints the total time and how long each phone was busy or idle. The runner must be
running.

```bash
pnpm --filter @nowait/runner benchmark --app <apk path or URL> --repeat 10
```

`POST /runs` takes the same options: `"split": "fixed" | "queue"` (default `queue`) and
`"repeat": N` (put every scenario in the run N times).

An [uneven-workload benchmark](docs/benchmarks/2026-11-05-uneven-workload.md) records all six measured
runs, idle time, workload sources and limitations using two identical Android emulators.

## Dashboard

Runs, each attempt with its error, screenshot and log, and the phones. A run's page has a timeline:
one lane per phone, one block per scenario. The gaps are time a phone waited.

```bash
pnpm --filter @nowait/web build   # once, and after every change in web/
```

Build it before you start the server: the server looks for it at startup. It then serves it at
`http://localhost:3000/dashboard/`. The browser asks for a user name
(any) and `DASHBOARD_PASSWORD`. It refreshes every 5 seconds (a finished run's page stops).

It can also:
- **Add a device.** On Phones, choose a runner machine and an installed virtual device, then
  register it or explicitly start and register it. For manual registration, enter its name, platform,
  UDID, Appium URL, machine (the runner's
  `HOST`) and system/WDA port. Start Appium and the runner on that machine; the runner picks up
  the registration within a minute. The form adds only: an existing name or UDID is an error,
  and its settings stay unchanged. Use `PUT /devices` to update an existing registration.
- **Start a new run.** On Runs, choose Android or iOS Simulator and enter the app build URL or
  Appium-host path. It uses the latest scenarios reported by a runner, shared queue assignment
  and one pass, then opens the new run's progress page. Connection errors appear in the form,
  which keeps its inputs if starting fails. Dashboard actions are attempted once when submitted.
- **Turn a phone off or on.** A phone that is off finishes its current scenario, then takes no
  more. Its items in a `fixed` run go to the other phones.
- **Cancel a running run.** Its open scenarios fail with "cancelled on the dashboard", and a phone
  running one stops at its next heartbeat.
- **Run a finished run again:** all its scenarios, only the failed ones, or one failed attempt.
  This starts a new run with the same app build, commit and split; the old run keeps its results.

The compact Runs page shows 10 runs per page. Status filters and search cover all saved runs;
summary counts cover only the current page. Filters and pagination are stored in the URL so views
can be bookmarked. Start run opens a keyboard-accessible dialog with custom dropdowns and optional
OS coverage. A failed start keeps the entered values; a failed refresh retains the last results
and offers Try again. Desktop pages keep headings, filters and pagination fixed while table data scrolls. Mobile pages
scroll naturally. Device registration opens in a dialog, and run details have separate overview,
attempts, coverage and timeline views. Standalone actions share visible secondary buttons.

Each action is written to the server log.

Phones shows runner connectivity separately from device activity: **waiting for runner** until
that device's worker first reports contact, **online** while contact is recent, then **offline**.
Last seen is the server's time of the most recent contact. Offline or uncontacted devices do not
show as idle. Enabled/disabled, health pauses and active leases remain separate: a runner can be
online while its device is paused or its Appium setup is failing.

Workers report contact immediately, then 30 seconds after each contact request finishes, including
while idle, installing/running an app or waiting for a health cooldown. Requests time out after
10 seconds and do not overlap; contact failures do not change test results. The server's
`DEVICE_OFFLINE_SECONDS` defaults to 120 (minimum 60, longer than the 30s interval plus 10s timeout).
The dashboard refreshes every 5 seconds; stale data during a failed refresh keeps its error notice.
This reports runner-to-server connectivity, not Appium or hardware readiness, and does not change
queue assignment or lease expiry.

Existing registrations start as waiting after migration. Restart runners with this version to
report contact; older runners can still run tests but do not send the new contact requests.
Registration and device-list reads do not count as contact. Contact persists across server
restarts and becomes offline if it ages past the threshold; a fresh report restores online.
Changing a registration's machine, UDID or platform clears its last-seen time, and contact from
its old identity cannot mark the replacement online.

To work on it, run `pnpm --filter @nowait/web dev` next to the server: Vite serves it at
`http://localhost:5173/dashboard/` and sends the API calls to the server on port 3000.

## Screenshots and logs

Each failed attempt keeps a screenshot and a log for `ARTIFACT_DAYS` (default 30). Where they live
is behind one interface, `ArtifactStore` (`server/src/storage/store.ts`):

- On the server's disk, under `ARTIFACT_DIR`. The default.
- In S3, when `S3_BUCKET` is set. Any S3-compatible service works: AWS S3, or RustFS / MinIO with
  `S3_ENDPOINT`. The bucket must exist; the server checks it at startup and stops if it can't use
  it. A bucket lifecycle rule that deletes objects after `ARTIFACT_DAYS` is a good safety net: the
  server's cleanup only knows the files its database points to.

To try S3 locally with RustFS: `docker compose --profile s3 up -d`, create a bucket (in the RustFS
console at http://localhost:9001, or with any S3 tool), then start the server with `S3_BUCKET`,
`S3_ENDPOINT=http://localhost:9000`, `S3_ACCESS_KEY_ID=nowait-test` and
`S3_SECRET_ACCESS_KEY=nowait-test-secret`.

## Notifications

When a run ends, the server posts it to chat: one message with the result, and each failed
scenario (error and screenshot) next to it, up to 10. Slack and Telegram can both be on. Every
platform implements the same `Notifier` interface (`server/src/notify/notifier.ts`), so adding one
is a new file plus one line in `server/src/notify/index.ts`. A run is sent once per platform; if
the platform is down, the server tries again every 15 seconds for a day. Runs that ended before a
platform was first turned on are not sent.

Slack: create a Slack app with a bot token (`chat:write`, `files:write`), add it to the channel,
and set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`. Set `PUBLIC_URL` to link each message to its run
on the dashboard.

Telegram: add a bot (from @BotFather) to a group with topics, and set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` (the group, like `-1001234567890`). Each kind of message can go to its own
topic, by its id (`message_thread_id`):

- `TELEGRAM_RUNS_TOPIC`: every run's summary. Unset: the General topic.
- `TELEGRAM_ERRORS_TOPIC`: each failed scenario, with its screenshot and a link to its run. Unset:
  replies to the run's summary.

A group takes about 20 messages a minute, so the bot waits 3 seconds between messages.

## Jenkins

[`examples/Jenkinsfile`](examples/Jenkinsfile) shows the stage to add to an app's pipeline, after
the build. It starts a run for the new APK and, by default, waits for it and fails the build if
the tests fail (`WAIT_FOR_RESULT`). Its timeout (90 minutes) must be longer than your slowest run.
It runs the scenarios the runner sent last.

Jenkins needs a "Secret text" credential `nowait-trigger-token` with the server's `TRIGGER_TOKEN`,
and the test machine must be able to download the APK from Jenkins.

## Real deployment

- Put the server behind HTTPS (a reverse proxy like Caddy or nginx). The server speaks plain HTTP,
  so without it the tokens and the dashboard password travel unencrypted.
- `appBuild` can be any URL or path, and the phones install it. Only give the trigger token to
  trusted callers.

### Verified run inputs

New runs record immutable input intent and bind their resolved app bytes, scenario checkout
tree/discovery folder, package/lock declarations and effective session mode/timeout before
executing a scenario. Changing bytes behind the same app path or URL fails verification on later
attempts and reruns. Reruns keep expected inputs separate from newly resolved inputs;
missing/expired or changed app inputs fail explicitly before observation is claimed. Legacy runs
retain unavailable input fields, and cannot claim an exact replay: start a new run instead.

The runner rejects dirty source anywhere in the scenario Git checkout before loading it and
checks again immediately before execution. Imported sibling helpers share the checkout identity;
source symlinks must remain inside it. Commit source and dependency declaration changes first,
and use a complete checkout without skip-worktree/assume-unchanged index flags. Use a
self-contained source checkout: submodules and opaque nested source checkouts fail explicitly.
Managed readiness markers and installed `node_modules` output are separate from scenario source.
Ignored executable source (JavaScript, TypeScript, native modules and common scripts) has a
separate byte digest; Git ignore rules cannot hide generated helper changes. Dependency identity
records package and lock declarations; it does not attest to arbitrary external services or
manually altered shared package stores. Operator-private Git excludes (local info/global
excludes) describe metadata; runtime code must not be imported through their external metadata
links. Ignored non-code data and separate private checkouts are outside this source record.
Runtime observations identify runner/Node/WebdriverIO and observable Appium, automation/driver
and OS versions per attempt; unavailable observations remain unknown.

Verified app staging requires Appium on the runner host with the same filesystem (loopback
Appium URL). Remote Appium-host files cannot be verified by reading a similarly named local
file; new verified runs fail explicitly for remote endpoints. The runner copies a local APK, ZIP
or Simulator `.app`, or downloads a URL to a private snapshot, and installs that snapshot.
APK/ZIP identity is SHA256 of bytes. Simulator-directory identity includes sorted relative
paths, entry types, executable bits, complete file bytes and internal symlink targets; it
excludes root folder names and timestamps and rejects escaping links/unsupported entries.
Snapshots stay until session cleanup is confirmed; uncertain cleanup retains them for operator
verification.

`INPUT_MAX_BYTES` defaults to 512 MiB (range 1 MiB–1 GiB); directories are limited to 100,000
entries and downloads to 120s. The byte budget also bounds ignored executable-source hashing.
This bounds accepted inputs, not a hard filesystem quota during a concurrent source mutation or
filesystem copy. URL locators may contain credentials: manifests redact their paths/query/user
info and never contain account passwords or runner tokens.

Upgrade the server and runners before starting verified runs: old runners can finish legacy work
but cannot lease new input-verifying runs. `POST /inputs` binds inputs under the active lease;
`POST /inputs/runtime` records immutable attempt observations. `GET /runs/:id/manifest?page=0`
returns the manifest and 50 attempt observations, with `next` for further pages. Runner and
trigger tokens can read it. The dashboard shows identities/observations and downloads the same
paged JSON through its authenticated manifest route. Input identity does not recreate an expired
app or backend environment; it explains mismatches and unavailability.

### Required device and OS coverage

Profiles are optional. A run without profiles keeps the shared queue behavior, including a
single physical phone or virtual device. To require virtual-device coverage, add up to10 named
profiles with `deviceClass` (`android-emulator` or `ios-simulator`) and an exact
`platformVersion` reported by Appium. All profiles in a run match its platform and share its app
artifact and scenario revision. Five scenarios with two profiles create ten required slots;
repeats multiply that coverage. Profile names are unique within the run.

```json
{
  "platform": "android",
  "appBuild": "/builds/app.apk",
  "profiles": [
    { "name": "android-15", "deviceClass": "android-emulator", "platformVersion": "15" },
    { "name": "android-16", "deviceClass": "android-emulator", "platformVersion": "16" }
  ]
}
```

Register each virtual device with its `platformVersion` using the dashboard or `PUT /devices`.
An omitted version in a device update preserves the existing setting; null clears it. Existing
registrations default to unknown and still serve ordinary runs. Android emulator profiles
require an adb emulator serial (`emulator-...`); iOS Simulator profiles require its UUID. Matching
registered versions determine scheduling eligibility; actual Appium session capabilities must
confirm the OS version and virtual-device class before the scenario can start. Unknown or
incompatible capabilities fail explicitly. Restart the runner after changing a device's host,
serial or Appium connection details; an existing worker cannot execute under a replacement
registration.

In the dashboard, optionally list required OS versions when starting a run. Run details show
counts per profile and explain when no enabled matching device is registered. This is eligibility,
not a readiness probe. Attempts, timeline labels, downloads and retries retain their profile;
reruns snapshot the original definitions and preserve each selected scenario/profile pair.
Profiles that receive no compatible progress for `STUCK_RUN_MINUTES` fail their pending slots,
even if another profile keeps progressing; an active compatible attempt is allowed to finish.
A missing profile is never counted as successful coverage. Booting devices and installing or
switching OS runtimes remain operator tasks.

Upgrade server and runners before using profiles. Older runners cannot lease required-profile
work. Historical runs keep their original queue behavior, nullable profile evidence and input
manifest semantics. Runtime/profile verification adds no new retry budget: an incompatible app
or runtime remains a visible setup failure under the saved limits.

### Attempt diagnostics

The run's paged attempts show the last reported phase: waiting for resources, app preparation,
session preparation/reset, executor startup, scenario execution, evidence collection, or cleanup.
Progress updates every five seconds while leased. Phase history and Appium command timings retain
only the latest 80 entries each, with omission counts. A stopped runner's last update can be stale;
progress never renews its lease or counts as successful scenario execution.

**Download diagnostics** returns an authenticated JSON bundle correlated by run, attempt, device,
scenario commit and session. It includes verified inputs, observed runtime, effective session mode
and scenario timeout, phase history, safe command timings, and a bounded original error. Before
session disposal, failed attempts also try to capture the existing screenshot, device log tail,
UI tree structure, and Appium event timings. Setup failures use the same path, including when
startup failed after creating a session. Missing or unsupported evidence has an explicit reason.
A legacy, interrupted, or expired attempt can still download available server metadata.

Capture shares a 15-second budget. Non-image Appium responses are capped at 256 KiB; device logs
retain at most 500 lines / 64 KiB, tree structure 64 KiB, and Appium timings 80 commands. Screenshots
use the existing authenticated artifact link and a 5 MiB response cap. The bundle omits command
bodies, selectors, headers, raw capabilities, UI text and attributes; it redacts known runner and
test-account credentials and URL locators from collected text. Remote Appium host logs are marked
unavailable because the session API does not expose them. Safe phase/command metadata supplies
the runner and gateway trace. Screenshots retain the existing failure-evidence policy and may
show app content.

Bundles use the same disk/S3 store, dashboard authentication and `ARTIFACT_DAYS` cleanup as other
artifacts. Collection, progress publication, or upload failure cannot change a test verdict.
Upgrade the server before runners to enable progress and bundle persistence.

### Managed backend fixtures

App reset clears app data; backend cleanup is an opt-in scenario contract. Existing scenarios
and `context.signal` keep working. Declare fixtures on the scenario and acquire them through
`context.use(fixture)`. Repeated use of the same declared fixture shares one setup promise and
value within that attempt. `context.attemptId` identifies the attempt.

```ts
import type { Fixture, Scenario } from '@nowait-qa/sdk'
import { backend } from './helpers/backend.ts' // your configured backend client

const cart: Fixture<{ id: string }> = {
  name: 'cart',
  setup: ({ key, attemptId, account, signal }) =>
    backend.provisionCart({ key, attemptId, account, signal }),
  async cleanup(context) {
    await backend.fenceAndDeleteCart(context)
    return backend.cartIsAbsent(context) // true only after verification
  },
}

export default {
  id: 'cart.checkout',
  platforms: ['android', 'ios'],
  fixtures: [cart],
  async run(driver, account, context) {
    const value = await context.use(cart)
    // Exercise the app against value.id. The parent manages cleanup afterward.
  },
} satisfies Scenario
```

The backend methods above illustrate the adapter contract; supply them in the scenario repo.
Both operations receive `{ key, attemptId, account, signal }`. The framework generates a unique
opaque idempotency key and commits its cleanup record **before** setup can contact the backend.
Setup may return any local value; that value never enters the journal or cleanup process.
Names are public identifiers: a letter followed by up to 63 letters, digits, dots, underscores or
hyphens. An attempt can register at most 20 fixtures.

Cleanup runs in a fresh process using the pinned, verified scenario code. It must find all its
resources by the supplied key, including partial setup and a lost setup response. Keep cleanup
independent of setup return values and mutable module variables. It must be idempotent and must
fence that key against late backend work before verifying absence. Stopping JavaScript cannot
undo an already accepted backend operation. When the backend cannot establish this guarantee,
return `false` or throw: the account stays quarantined. Keys identify resources; they are not
backend authentication credentials. Use the supplied account or your configured backend client.

Fixtures clean up in reverse registration order after the original executor stops, command
traffic is fenced, the parent acknowledges its session reservation and the attempt result is saved. A later unverified fixture blocks earlier
fixtures of that attempt; unrelated attempts can continue. Setup and cleanup have a fixed 30-second
ceiling, shortened by the recorded `SCENARIO_TIMEOUT_SECONDS`. Cleanup uses that attempt's saved
configuration, including after a runner restart. The normal scenario deadline still bounds the
whole scenario body. Source preparation and process termination are also bounded by a cleanup
claim with time reserved for stopping the child and acknowledging the result.

The assertion verdict is preserved separately from cleanup health. A passed scenario can have
quarantined fixtures; its account remains unavailable until every registered resource is verified
clean. A failed but confirmed-stopped cleanup releases the phone for other clean accounts. The
server retries eligible cleanup at most `MAX_FIXTURE_CLEANUP_ATTEMPTS` times (default 3, maximum 10),
with at least `FIXTURE_RETRY_SECONDS` between attempts (default 60). An eligible runner for the
registered device performs reconciliation; disabled/offline devices may need their runner enabled
or restored first. Pending cleanup retains the exact scenario revision across cache refresh and
runner restart.

A cleanup child owns a reservation too. An expired claim or lost parent does not prove that the
old executor or accepted backend work stopped, so neither a timer nor ordinary cleanup
acknowledgement can recycle that uncertain state. The **Fixtures** page shows pending, cleaning,
quarantined and retained clean resources. Run pages link to an attempt's fixture history and keep
refreshing while cleanup is pending. The Phones page distinguishes active fixture cleanup from an
unconfirmed reservation. After the claim window ends, **Retry cleanup** requires explicit operator
confirmation that the old runner, scenario/cleanup processes, Appium session and accepted backend
operations have stopped. It schedules verified cleanup; it does not declare an account clean.
Runner logs identify the cleanup process group and resource record for investigation.

Resource records contain only opaque keys, public names and lifecycle metadata, never passwords,
backend URLs or setup return values. Lists are paged 50 at a time. Verified-clean records expire
after `ARTIFACT_DAYS` through a bounded database job; uncertain records remain to protect their
resources and accounts. Diagnostic downloads link to the corresponding fixture records.

The runner API provides `POST /fixtures/register`, `/fixtures/claim`, `/fixtures/finish`,
`GET /fixtures?after=...&queueId=...` and `POST /fixtures/:id/retry`. Dashboard reads/actions use
`/dashboard/api/fixtures` with the existing authentication and action-header rules. Trigger tokens
cannot manage fixtures. Retry requires `{ "confirmedStopped": true }`; finish requires the current
opaque claim and confirmed child termination before accepting verified cleanup. Upgrade the
server and all relevant runners before adopting fixtures; old servers still support ordinary scenarios, and managed setup
fails explicitly before provisioning when the fixture protocol is absent.

### Release gates and scenario reliability

Execution results keep their existing meaning: a failed-then-passed application attempt is
`flaky`, and a run can finish `passed` after recovery. A release gate records whether those
results satisfy the policy selected when the run starts:

```json
{ "platform": "android", "appBuild": "/builds/app.apk", "releasePolicy": "strict" }
```

`releasePolicy` defaults to `permissive`, which accepts later-pass recovery. `strict` rejects
flaky required scenarios. Both reject failed or missing required coverage. Policies do not
change retries, raw results or assertion classification. Fixture cleanup health remains separate. The dashboard's start form exposes
both policies; a run page shows its gate separately from execution status.

`GET /runs/:id` and its dashboard equivalent return `release.gate` with `policy`, `status`
(`pending`, `accepted`, `rejected`), `reason` and scenario counts. The effective policy is saved
at creation, and the terminal decision is saved atomically with run completion, including
cancellation, lost-device and missing-profile paths. Server restarts cannot change it. CI should
wait until the gate is no longer `pending`, then require `accepted`; the Jenkins example does
this and needs curl and Node.js on its agent. Its `RELEASE_POLICY` parameter defaults to
permissive. A server without this field fails the new example with an upgrade message.
Legacy consumers may continue using the unchanged top-level `status` if they intentionally
want the old execution-only check.

Runs created before this feature have `release.source: "legacy"`: their permissive decision is
derived and explicitly labelled, not presented as a saved historical policy. New runs use
`source: "saved"`; a missing terminal saved decision rejects rather than inferring acceptance.
Reruns inherit the saved policy and link to their parent through `release.rerunOf`, preserving
original history. Failed-only and single-attempt reruns are marked `partialCoverage` and cannot
certify a full release. Re-running such a subset stays partial; start a new full run for a
release decision. Known-failure exceptions and silent scenario exclusions are not supported.

The **Reliability** page and `GET /history` (or `/dashboard/api/history`) provide paginated
scenario history. Supply `scenarioId`, `platform`, and optional `days` (7, 30 or 90; default 30).
The default window uses the database clock, like run timestamps. The response gives `from`, `until`, up to 50 cohort entries and a `next` cursor. Send that cursor
as `after` and preserve the returned `until` on subsequent pages to keep the same completed-run
window. Trigger tokens may read this history; dashboard authentication uses its existing rules.

Each entry aggregates the whole window for one exact cohort of scenario commit, verified app
and source/dependency bytes, effective configuration, queue/fixed split, required profile, saved retry/recovery limits, full/subset scope and
observed runtime identities. Sample counts refer to scenario slots, not retries. Different
builds/environments remain separate. Incomplete, legacy or mixed-runtime identities are visibly
isolated to their own run and do not receive a comparable reliability percentage. Latest-run
links expose the original attempts; pagination never changes a cohort's sample denominator.

History distinguishes first completed application passes, later application passes, exhausted
application failures, application failures with interrupted recovery, infrastructure-only terminal interruptions, unknown outcomes and the
number of infrastructure interruptions across attempts. An infrastructure interruption is
not an application assertion failure. The first application-pass percentage uses first passes,
later passes, exhausted application failures and interrupted application failures as its denominator; infrastructure-only and
unknown outcomes are excluded, with all counts shown. Raw flaky sample counts remain visible,
including conservative retry classification after infrastructure interruptions. Gate decisions
continue to use those raw scenario outcomes. History does not automatically quarantine tests,
change release policy, or rewrite failed-only reruns into the original run.


## Frontend conventions

The dashboard uses shared React controls and centralized CSS tokens. Feature imports, data access,
control usage and styling are checked by `pnpm check:ui`, included in `pnpm lint`.
`pnpm check:ui:selftest` verifies the checks with disposable failure/allowed examples. CI runs
typecheck, lint, policy self-tests and the web build. See [frontend structure and checks](docs/frontend.md)
for the folder layout, enforced boundaries and browser-review requirements.

### Launch Android and iOS together

In **Start run**, choose **Android + iOS Simulator**, supply an Android APK and an iOS Simulator
`.app`/ZIP, and optionally set OS coverage for each platform. One launch contains two independent
runs on the same scenario commit and shared release policy. They enter the queue atomically;
execution still depends on registered devices. The launch view links to each run's full evidence,
controls and retry history. A launch accepts release only when both platform gates accept; a child
rerun creates separate history and does not replace the original launch result.

Automation can call `POST /launches` with the trigger or runner token:

```json
{
  "id": "b379bcf3-42f4-432e-84d0-b7fda20ea7c0",
  "targets": [
    { "platform": "android", "appBuild": "https://builds.example.com/app.apk" },
    { "platform": "ios", "appBuild": "https://builds.example.com/app.app.zip" }
  ]
}
```

Generate a fresh UUID for each intentional launch. Repeating the same UUID and normalized request
returns the same launch, including after a lost response or server restart. Reusing it with different
settings returns400. Each target accepts the existing run options; commit, trigger, releasePolicy,
split and repeat must match across targets. Profiles/builds are platform-specific. One catalog is
resolved for the launch; missing platform scenarios rejects it without creating either run.
`GET /launches/:id` returns both run summaries, the combined execution status and a separate release
status. Dashboard equivalents are `/dashboard/api/launches` and `/dashboard/api/launches/:id`, using
Basic auth and the existing action header for POST. Existing single-platform `/runs` is unchanged.

Migration0021 adds the launch request table, nullable run grouping key and unique(platform,launch)
index. Legacy runs remain ungrouped. Request identities follow the same retained-history lifecycle
as runs; artifacts keep their existing retention policy. No runner or mobile-driver changes needed.

Guided virtual setup uses the same compact Phones views as registered devices. Choose **Set up
virtual device**, select a runner machine and an installed device, then explicitly start/register
it. Setup progress and recovery have their own URL views; table data scrolls on desktop and
mobile pages flow naturally. iOS Simulator test sessions also set Appium `isHeadless: true`, so
ordinary execution keeps Simulator.app closed after setup. See the
[Appium Simulator capabilities](https://appium.github.io/appium-xcuitest-driver/10.43/reference/capabilities/).

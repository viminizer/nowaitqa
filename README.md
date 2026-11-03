# nowait-qa

Run mobile app tests on real phones with Appium, from one shared queue.
Any free phone takes the next test, so fast phones never wait for slow ones.

Status: in development.

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
- `TRIGGER_TOKEN`: Jenkins. It can only start a run and read it (`POST /runs`, `GET /runs/:id`).

| Route                | Who calls it | What it does                                                       |
| -------------------- | ------------ | ------------------------------------------------------------------ |
| `POST /runs`         | Jenkins      | Start a run: puts every scenario for the platform in the queue     |
| `GET /runs/:id`      | anyone       | Run status, and each scenario as pending / passed / flaky / failed |
| `PUT /devices`       | you          | Add or change a phone (runner token)                               |
| `GET /devices?host=` | runner       | The phones plugged into one machine                                |
| `PUT /catalog`       | runner       | Send its scenario list and their git commit (at startup)           |
| `POST /lease`        | runner       | Take the next scenario. Waits up to 30s if there is none           |
| `POST /heartbeat`    | runner       | Keep a lease alive while a scenario runs                           |
| `POST /results`      | runner       | Report pass or fail, with a screenshot and a log                   |

A failed scenario runs once more. A lease that is not kept alive runs out, and the scenario goes
back to the queue. A run is stuck when no phone of its platform has taken or finished any work for
`STUCK_RUN_MINUTES` (default 15), for example when no phone is connected. A stuck run fails.
After a restart, the server waits that long before calling a run stuck, and one lease time before
expiring a lease, so phones have time to come back.

## Runner

Runs on the machine the phones are plugged into, next to Appium. One worker per phone: each takes
the next scenario from the server, runs it, reports it, and repeats.

Settings are listed in `runner/env.example`:

```bash
appium --port 4723   # one Appium server for all phones (UiAutomator2 driver)
export SERVER_URL=http://localhost:3000 RUNNER_TOKEN=<the server's RUNNER_TOKEN> HOST=macmini-1
pnpm --filter @nowait/runner start
```

Appium 3 needs the UiAutomator2 driver 8.x (tested with
`appium driver install uiautomator2@8.7.3`). Driver 9.x needs Appium 4.

Add each phone once with `PUT /devices` (`host` must match the runner's `HOST`). The runner picks
up new phones within a minute.

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
the server. Runs started on the previous commit still finish.

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

## Dashboard

Runs, each attempt with its error, screenshot and log, and the phones. A run's page has a timeline:
one lane per phone, one block per scenario. The gaps are time a phone waited.

```bash
pnpm --filter @nowait/web build   # once, and after every change in web/
```

Build it before you start the server: the server looks for it at startup. It then serves it at
`http://localhost:3000/dashboard/`. The browser asks for a user name
(any) and `DASHBOARD_PASSWORD`. It is read-only, and refreshes every 5 seconds (a finished run's
page stops).

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

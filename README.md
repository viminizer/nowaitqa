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
there have that default. Set at least the database and the two tokens:

```bash
export DATABASE_URL=postgres://nowait:nowait@localhost:5432/nowait
export RUNNER_TOKEN=<random, 16+ characters> TRIGGER_TOKEN=<another one>
export SCENARIOS_DIR=../examples/scenarios   # relative to server/
pnpm --filter @nowait/server dev
```

Every request needs `Authorization: Bearer <token>`, except `GET /health`. There are two tokens:

- `RUNNER_TOKEN`: the runner. It can call every route.
- `TRIGGER_TOKEN`: Jenkins. It can only start a run and read it (`POST /runs`, `GET /runs/:id`).

| Route                | Who calls it | What it does                                                       |
| -------------------- | ------------ | ------------------------------------------------------------------ |
| `POST /runs`         | Jenkins      | Start a run: puts every scenario for the platform in the queue     |
| `GET /runs/:id`      | anyone       | Run status, and each scenario as pending / passed / flaky / failed |
| `PUT /devices`       | you          | Add or change a phone (runner token)                               |
| `GET /devices?host=` | runner       | The phones plugged into one machine                                |
| `POST /lease`        | runner       | Take the next scenario. Waits up to 30s if there is none           |
| `POST /heartbeat`    | runner       | Keep a lease alive while a scenario runs                           |
| `POST /results`      | runner       | Report pass or fail, with a screenshot and a log                   |

A failed scenario runs once more. A lease that is not kept alive runs out, and the scenario goes
back to the queue. A run is stuck when no phone of its platform has taken or finished any work for
`STUCK_RUN_MINUTES` (default 15), for example when no phone is connected. A stuck run fails.

## Runner

Runs on the machine the phones are plugged into, next to Appium. One worker per phone: each takes
the next scenario from the server, runs it, reports it, and repeats.

Settings are listed in `runner/env.example`:

```bash
appium --port 4723   # one Appium server for all phones (UiAutomator2 driver)
export SERVER_URL=http://localhost:3000 RUNNER_TOKEN=<the server's RUNNER_TOKEN> HOST=macmini-1
export SCENARIOS_DIR=../examples/scenarios   # relative to runner/
pnpm --filter @nowait/runner start
```

Appium 3 needs the UiAutomator2 driver 8.x (tested with
`appium driver install uiautomator2@8.7.3`). Driver 9.x needs Appium 4.

Add each phone once with `PUT /devices` (`host` must match the runner's `HOST`). The runner picks
up new phones within a minute.

## Scenarios

Scenarios live in your own folder or repo, not in nowait-qa. Point `SCENARIOS_DIR` (runner and
server) at it. The folder must be inside a git checkout: a run names a commit, and the runner
refuses to run a scenario from a different one.

One file per scenario, directly in the folder. The file name is the scenario id. Sub-folders
(helpers) are not scenarios. Get the `Scenario` type from `@nowait-qa/sdk`:

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
[ApiDemos](https://github.com/appium/android-apidemos) app.

## Benchmark

Runs the same scenarios twice - each phone with a fixed list (the old way), then the shared
queue - and prints the total time and how long each phone was busy or idle. The runner must be
running.

```bash
pnpm --filter @nowait/runner benchmark --app <apk path or URL> --repeat 10
```

`POST /runs` takes the same options: `"split": "fixed" | "queue"` (default `queue`) and
`"repeat": N` (put every scenario in the run N times).

## Jenkins

[`examples/Jenkinsfile`](examples/Jenkinsfile) shows the stage to add to an app's pipeline, after
the build. It starts a run for the new APK and, by default, waits for it and fails the build if
the tests fail (`WAIT_FOR_RESULT`). Its timeout (90 minutes) must be longer than your slowest run.
It runs the scenarios from the latest `main` of your scenarios repo (`SCENARIOS_REPO`), so keep the
runner's `SCENARIOS_DIR` on `main`.

Jenkins needs a "Secret text" credential `nowait-trigger-token` with the server's `TRIGGER_TOKEN`,
and the test machine must be able to download the APK from Jenkins.

## Real deployment

- Put the server behind HTTPS (a reverse proxy like Caddy or nginx). The server speaks plain HTTP,
  so without it the tokens travel unencrypted.
- `appBuild` can be any URL or path, and the phones install it. Only give the trigger token to
  trusted callers.

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

```bash
cp server/.env.example server/.env   # then set API_TOKEN
pnpm --filter @nowait/server dev
```

Every request needs `Authorization: Bearer <API_TOKEN>`, except `GET /health`.

| Route                | Who calls it | What it does                                                       |
| -------------------- | ------------ | ------------------------------------------------------------------ |
| `POST /runs`         | Jenkins      | Start a run: puts every scenario for the platform in the queue     |
| `GET /runs/:id`      | anyone       | Run status, and each scenario as pending / passed / flaky / failed |
| `PUT /devices`       | you          | Add or change a phone                                              |
| `GET /devices?host=` | runner       | The phones plugged into one machine                                |
| `POST /lease`        | runner       | Take the next scenario. Waits up to 30s if there is none           |
| `POST /heartbeat`    | runner       | Keep a lease alive while a scenario runs                           |
| `POST /results`      | runner       | Report pass or fail, with a screenshot and a log                   |

A failed scenario runs once more. A lease that is not kept alive runs out, and the scenario goes
back to the queue.

## Runner

Runs on the machine the phones are plugged into, next to Appium. One worker per phone: each takes
the next scenario from the server, runs it, reports it, and repeats.

```bash
appium --port 4723                    # one Appium server for all phones (UiAutomator2 driver)
cp runner/.env.example runner/.env    # then set API_TOKEN and HOST
pnpm --filter @nowait/runner start
```

Add each phone once with `PUT /devices` (`host` must match the runner's `HOST`). The runner picks
up new phones within a minute. The runner must be on the same git commit as the run.

## Scenarios

One file per scenario in `scenarios/`. The file name is the scenario id:

```ts
// scenarios/views.checkbox.ts
export default {
  id: 'views.checkbox',
  platforms: ['android'],
  async run(driver, account) {
    // drive the app with WebdriverIO; wait for elements, never sleep
  },
} satisfies Scenario
```

Each scenario starts from a fresh app (data cleared). The samples test Appium's
[ApiDemos](https://github.com/appium/android-apidemos) app.

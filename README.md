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

# Nowait CLI

Run commands from this repository. The CLI is a private TypeScript workspace package;
it uses the same schemas and server operations as the dashboard. It contains no model,
agent loop or MCP server.

## Setup

Install with `pnpm install`. Configure a distinct `CLI_TOKEN` (at least 16 characters) on the
server and restart it. Configure `NOWAIT_TOKEN` with that value in the caller's environment.
`NOWAIT_SERVER_URL` defaults to `http://127.0.0.1:3000`; use HTTPS outside a trusted local
environment. Credentials are never command arguments and are not saved by the CLI.

The CLI token can read and change dashboard API resources. It cannot acquire leases, publish
catalogs, impersonate runner contact, submit test results or access the dashboard HTML.
It is a workspace credential, not an individual user identity. It must differ from the runner
token, trigger token and dashboard password. Leaving `CLI_TOKEN` unset preserves existing auth.

```sh
pnpm --silent nowait --help
pnpm --silent nowait runs --help
pnpm --silent nowait capabilities --json
pnpm --silent nowait runs list --limit 10 --json
pnpm --silent nowait runs show 642 --json
pnpm --silent nowait runs failures 642 --page 0 --json
pnpm --silent nowait runs retry 642 --failed --json
pnpm --silent nowait runs wait 643 --timeout 300 --json
```

Use `--silent` to suppress package-manager banners when consuming JSON. A workspace command
is also available with `pnpm --filter @nowait/cli --silent start …`; the package declares its
`nowait` executable for workspace linking. No separate build step or global install is needed.
`--server URL` overrides the server URL. `--request-timeout SECONDS` overrides the per-request
deadline (`NOWAIT_REQUEST_TIMEOUT`, default 30 seconds). Options work before or after the command;
unknown, inapplicable and duplicate options fail without sending a request.

## Start runs

`runs start --input FILE` accepts a `CreateRunBody` JSON file. For example:

```json
{
  "platform": "android",
  "appBuild": "/builds/app.apk",
  "trigger": "cli",
  "releasePolicy": "permissive"
}
```

```sh
pnpm --silent nowait runs start --input run.json --json
```

Build paths belong to the Appium host, not necessarily the CLI machine. Existing server and
runner verification rules still apply. Omit `commit` to select the newest runner catalog,
or specify it to pin a revision. Profiles, repeat and split use the shared request schema.

`launches start --input FILE` accepts the existing `CreateLaunchBody` with a caller-selected
UUID and exactly one target per platform:

```json
{
  "id": "cddbd622-7a36-4e49-8bdf-66c5124d85bc",
  "targets": [
    { "platform": "android", "appBuild": "/builds/app.apk", "trigger": "cli" },
    { "platform": "ios", "appBuild": "/builds/app.app.zip", "trigger": "cli" }
  ]
}
```

Both targets must share commit, trigger, policy, repeat and split. Read progress with
`launches show UUID` or `launches wait UUID --timeout 300`. Child runs retain independent results.
`capabilities --json` includes JSON input schemas for file-based commands. Cross-field business
constraints are additionally enforced by shared Zod validation and the server.

## Inspect evidence and manage resources

```sh
pnpm --silent nowait runs attempts 642 --page 0 --json
pnpm --silent nowait runs manifest 642 --page 0 --json
pnpm --silent nowait attempts diagnostics 1001 --json
pnpm --silent nowait attempts log 1001 --json
pnpm --silent nowait attempts screenshot 1001 --output ./failure.png --json
pnpm --silent nowait attempts retry 1001 --json
pnpm --silent nowait runs cancel 643 --json
pnpm --silent nowait devices list --json
pnpm --silent nowait devices add --input device.json --json
pnpm --silent nowait devices disable phone-name --json
pnpm --silent nowait devices enable phone-name --json
pnpm --silent nowait setup hosts --json
pnpm --silent nowait setup targets --host my-machine --json
pnpm --silent nowait setup start --host my-machine --key android:My_AVD --boot --json
pnpm --silent nowait setup show 12 --json
pnpm --silent nowait setup wait 12 --timeout 480 --json
pnpm --silent nowait setup cancel 12 --json
pnpm --silent nowait fixtures list --queue-id 1001 --json
pnpm --silent nowait history show views.checkbox --platform android --days 30 --json
```

`setup start` without `--boot` only registers a running target. Discovery never boots a device.
Explicit setup uses the existing headless runner flow. Setup cancellation may leave the VM running.
`setup resolve ID --confirmed-stopped` and `fixtures retry ID --confirmed-stopped` require the
operator to actually stop and verify the old execution/requests first. The flag is an assertion,
not an instruction to stop processes. There are no interactive prompts or blanket `--yes` bypass.

Lists return one bounded page with the server's cursor. Follow `older` with `--before`, `next`
with `--after`, or the returned numeric page with `--page`, as applicable. History cursor
requests must retain the returned `until` timestamp. Never assume an empty `runs failures`
page means there are no more pages: it filters failed attempts on the requested attempt page.
These include earlier failures of scenarios that later passed; `runs show` has final scenario
outcomes, and `runs retry --failed` selects final failed scenarios on the server.

Log text is escaped inside output data. Screenshots require `--output`, create a file with owner-only
permissions and never overwrite an existing file. Their receipt includes the absolute path, bytes
and SHA-256. Input JSON is limited to a regular file of 1 MiB; responses/downloads are limited to
20 MiB. Reads are validated against shared schemas before reporting success.

## Output and execution contract

JSON mode writes exactly one document to stdout:

```json
{ "ok": true, "data": { "id": 643 } }
```

```json
{
  "ok": false,
  "error": {
    "code": "not_found",
    "message": "Server answered HTTP 404: run not found",
    "status": 404
  }
}
```

Without `--json`, data is pretty-printed JSON and errors go to stderr. Wait commands emit only a
terminal result, not a stream of progress documents. Exit codes:

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| 0    | Command succeeded; ordinary reads can successfully return a failed run            |
| 1    | Server, transport or response-contract failure                                    |
| 2    | Invalid arguments, configuration, request file or destination                     |
| 3    | Authentication/authorization refused                                              |
| 4    | Total wait deadline reached; latest observed data is included when available      |
| 5    | Wait finished with failure, cancellation, interruption or a rejected release gate |
| 130  | CLI interrupted; server work is not implicitly cancelled                          |

`runs wait` requires both a passed run and an accepted release gate; an unavailable legacy
decision is not treated as accepted. `launches wait` requires both platforms and their gates.
Ctrl+C/SIGTERM cancels in-flight observation, not a previously created run. Use `runs cancel`
explicitly. Total wait deadlines include network requests and polling delays.

No HTTP request is automatically retried. If a write loses its response or receives a server
error, `error.outcome` is `unknown`: inspect server state before retrying. Single-run starts
and retries are not idempotent. Grouped launches support recovery by reusing the **same UUID
and same request**; changing settings under that UUID is rejected. HTTP redirects are refused
so a server/proxy cannot redirect a mutation or credential to another location.

## Structure

```text
cli/
  package.json
  src/
    main.ts              # Entry, argument dispatch and process lifecycle
    command.ts           # Command/option contracts shared by help and execution
    config.ts            # Validated environment and command overrides
    client.ts            # Authenticated, bounded HTTP and shared response validation
    input.ts             # Bounded JSON files and exclusive artifact downloads
    output.ts            # JSON envelopes, errors and exit codes
    wait.ts              # Bounded observation and interruption
    commands/
      index.ts           # Single command registry
      runs.ts
      launches.ts
      attempts.ts
      devices.ts
      setup.ts
      fixtures.ts
      history.ts
```

Resource commands compose shared infrastructure and import API contracts from `shared/`.
They never import server/runner internals, access Postgres or duplicate scheduling logic.
Add a command in its resource module; registration supplies both executable behavior and
help/discovery metadata. Root `pnpm typecheck` and `pnpm lint` include the package.

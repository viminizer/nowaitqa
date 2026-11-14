#!/usr/bin/env -S tsx
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { Client } from './client.ts'
import { options, text } from './command.ts'
import { commands } from './commands/index.ts'
import { loadConfig } from './config.ts'
import { CliError, failure, success } from './output.ts'

const argv = process.argv.slice(2)
let json = argv
  .slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'))
  .includes('--json')
const shutdown = new AbortController()
const stop = () => shutdown.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

const globals = ['json', 'help', 'server', 'request-timeout'] as const
try {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, tokens: true, strict: true })
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Unknown or malformed option. Run nowait --help or nowait capabilities --json.',
      2,
    )
  }
  const { positionals, values, tokens } = parsed
  json = values.json === true
  const seen = new Set<string>()
  for (const token of tokens ?? [])
    if (token.kind === 'option') {
      if (seen.has(token.name))
        throw new CliError('invalid_arguments', 'Duplicate options are not allowed', 2)
      seen.add(token.name)
    }
  const name = positionals.slice(0, 2).join(' ')
  const command = commands.find((c) => c.name === name)
  const discovery = positionals[0] === 'capabilities'
  if (discovery || values.help || positionals.length === 0) {
    if (discovery && positionals.length !== 1)
      throw new CliError('invalid_arguments', 'capabilities takes no positional arguments', 2)
    const matching = command
      ? [command]
      : positionals.length === 1 && !discovery
        ? commands.filter((c) => c.name.startsWith(`${positionals[0]} `))
        : commands
    if (
      positionals.length &&
      !discovery &&
      !command &&
      (positionals.length !== 1 || matching.length === 0)
    )
      throw new CliError('invalid_arguments', 'Unknown command', 2)
    const data = {
      protocolVersion: 1,
      usage: 'pnpm --silent nowait <resource> <command> [arguments] [options]',
      globals: Object.fromEntries(globals.map((key) => [key, options[key]])),
      exitCodes: {
        '0': 'success',
        '1': 'request/server/contract failure',
        '2': 'invalid arguments/config/input/file',
        '3': 'unauthorized/forbidden',
        '4': 'wait deadline',
        '5': 'terminal work failed or release gate rejected',
        '130': 'interrupted; server work is not implicitly cancelled',
      },
      commands: matching.map(({ run: _, inputSchema, ...c }) => ({
        ...c,
        ...(inputSchema
          ? { inputSchema: z.toJSONSchema(inputSchema, { io: 'input', unrepresentable: 'any' }) }
          : {}),
        options: Object.fromEntries(c.options.map((key) => [key, options[key]])),
      })),
    }
    if (json) success(data, true)
    else
      process.stdout.write(
        `${data.usage}\n\n${data.commands
          .map(
            (c) =>
              `${c.name} ${c.args.map((a) => `<${a}>`).join(' ')}\n  ${c.summary}\n  ${Object.keys(
                c.options,
              )
                .map((key) => `--${key}`)
                .join(' ')}`,
          )
          .join(
            '\n',
          )}\n\nGlobal options: ${globals.map((key) => `--${key}`).join(', ')}\nDiscover contracts: nowait capabilities --json\n`,
      )
  } else {
    if (!command || positionals.length !== 2 + command.args.length)
      throw new CliError(
        'invalid_arguments',
        'Unknown command or wrong number of arguments; use --help',
        2,
      )
    const allowed = new Set<string>([...globals, ...command.options])
    if ([...seen].some((key) => !allowed.has(key)))
      throw new CliError(
        'invalid_arguments',
        'Option does not apply to this command; use --help',
        2,
      )
    const client = new Client(
      loadConfig(text(values, 'server'), text(values, 'request-timeout')),
      shutdown.signal,
    )
    const data = await command.run({
      client,
      args: positionals.slice(2),
      values,
      signal: shutdown.signal,
    })
    success(data, json)
  }
} catch (err) {
  failure(
    err instanceof z.ZodError
      ? new CliError(
          'invalid_input',
          err.issues.map((i) => `${i.path.join('.') || 'argument'}: ${i.message}`).join('; '),
          2,
        )
      : err,
    json,
  )
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}

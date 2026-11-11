import { CreatedRun, DbIdParam, DiagnosticDownload } from '@nowait/shared'
import { type Command, text } from '../command.ts'
import { saveDownload } from '../input.ts'
import { CliError } from '../output.ts'

export const attempts: Command[] = [
  {
    name: 'attempts diagnostics',
    summary: 'Read retained diagnostics, metadata and evidence links',
    args: ['id'],
    options: [],
    mutates: false,
    run: ({ client, args }) =>
      client.json(`/attempts/${DbIdParam.parse(args[0])}/diagnostics`, DiagnosticDownload),
  },
  {
    name: 'attempts retry',
    summary: 'Create a new run for the selected attempt',
    args: ['id'],
    options: [],
    mutates: true,
    run: ({ client, args }) =>
      client.json(`/attempts/${DbIdParam.parse(args[0])}/again`, CreatedRun, {}),
  },
  {
    name: 'attempts log',
    summary: 'Read a retained UTF-8 log as escaped text data',
    args: ['id'],
    options: [],
    mutates: false,
    run: async ({ client, args }) => ({
      content: (
        await client.download(`/attempts/${DbIdParam.parse(args[0])}/log`, 'text/plain')
      ).toString('utf8'),
    }),
  },
  {
    name: 'attempts screenshot',
    summary: 'Download retained PNG to a new file and return path, size and SHA-256',
    args: ['id'],
    options: ['output'],
    mutates: false,
    run: async ({ client, args, values }) => {
      const path = text(values, 'output')
      if (!path) throw new CliError('invalid_arguments', '--output FILE is required', 2)
      return saveDownload(
        path,
        await client.download(`/attempts/${DbIdParam.parse(args[0])}/screenshot`, 'image/png'),
      )
    },
  },
]

import { DeviceBody, DeviceEnabledBody, DeviceList } from '@nowait/shared'
import { z } from 'zod'
import { type Command, text } from '../command.ts'
import { readInput } from '../input.ts'

const deviceInput = DeviceBody.strict()

export const devices: Command[] = [
  {
    name: 'devices list',
    summary: 'Read registrations, connectivity, busy work and cleanup holds',
    args: [],
    options: [],
    mutates: false,
    run: ({ client }) => client.json('/devices', DeviceList),
  },
  {
    name: 'devices add',
    summary: 'Add a new registration from a DeviceBody JSON file; never overwrite',
    args: [],
    options: ['input'],
    inputSchema: deviceInput,
    mutates: true,
    run: async ({ client, values }) =>
      client.json('/devices', z.null(), await readInput(text(values, 'input'), deviceInput)),
  },
  ...[true, false].map(
    (enabled): Command => ({
      name: `devices ${enabled ? 'enable' : 'disable'}`,
      summary: `${enabled ? 'Allow' : 'Stop'} acquisition of new work; existing leases finish normally`,
      args: ['name'],
      options: [],
      mutates: true,
      run: ({ client, args }) =>
        client.json(
          `/devices/${encodeURIComponent(z.string().min(1).parse(args[0]))}/enabled`,
          z.null(),
          DeviceEnabledBody.parse({ enabled }),
        ),
    }),
  ),
]

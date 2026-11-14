import { CreatedLaunch, CreateLaunchBody, LaunchDetail } from '@nowait/shared'
import { z } from 'zod'
import { type Command, text } from '../command.ts'
import { readInput } from '../input.ts'
import { waitFor } from '../wait.ts'

const launchInput = CreateLaunchBody.strict()

export const launches: Command[] = [
  {
    name: 'launches start',
    summary:
      'Launch Android and iOS from CreateLaunchBody JSON; reuse its UUID and exact body to recover a lost response',
    args: [],
    options: ['input'],
    inputSchema: launchInput,
    mutates: true,
    run: async ({ client, values }) =>
      client.json('/launches', CreatedLaunch, await readInput(text(values, 'input'), launchInput)),
  },
  {
    name: 'launches show',
    summary: 'Read both child runs and their combined outcome/release gate',
    args: ['id'],
    options: [],
    mutates: false,
    run: ({ client, args }) => client.json(`/launches/${z.uuid().parse(args[0])}`, LaunchDetail),
  },
  {
    name: 'launches wait',
    summary: 'Observe both targets: exit 5 on failure/rejected gate, 4 on deadline',
    args: ['id'],
    options: ['timeout'],
    mutates: false,
    run: ({ client, args, values, signal }) =>
      waitFor(
        (deadline) =>
          client.json(`/launches/${z.uuid().parse(args[0])}`, LaunchDetail, undefined, deadline),
        (launch) => launch.status === 'running',
        (launch) => launch.status === 'passed' && launch.releaseStatus === 'accepted',
        text(values, 'timeout'),
        signal,
      ),
  },
]

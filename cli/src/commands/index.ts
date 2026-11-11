import { attempts } from './attempts.ts'
import { devices } from './devices.ts'
import { fixtures } from './fixtures.ts'
import { history } from './history.ts'
import { launches } from './launches.ts'
import { runs } from './runs.ts'
import { setup } from './setup.ts'

// Discovery, help and execution use the same registry, so command documentation cannot drift.
export const commands = [
  ...runs,
  ...launches,
  ...attempts,
  ...devices,
  ...setup,
  ...fixtures,
  ...history,
]

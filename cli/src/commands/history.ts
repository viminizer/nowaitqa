import { ScenarioHistoryPage, ScenarioHistoryQuery } from '@nowait/shared'
import { query } from '../client.ts'
import { type Command, text } from '../command.ts'

export const history: Command[] = [
  {
    name: 'history show',
    summary: 'Read comparable scenario cohorts; preserve until across cursor pages',
    args: ['scenario-id'],
    options: ['platform', 'days', 'until', 'after'],
    mutates: false,
    run: ({ client, args, values }) =>
      client.json(
        query(
          '/history',
          ScenarioHistoryQuery.parse({
            scenarioId: args[0],
            platform: text(values, 'platform'),
            days: text(values, 'days'),
            until: text(values, 'until'),
            after: text(values, 'after'),
          }),
        ),
        ScenarioHistoryPage,
      ),
  },
]

import { DbIdParam, FixturePage, FixtureQuery, FixtureRetryBody } from '@nowait/shared'
import { z } from 'zod'
import { query } from '../client.ts'
import { type Command, text } from '../command.ts'

export const fixtures: Command[] = [
  {
    name: 'fixtures list',
    summary: 'Read a page of retained fixture cleanup records; follow next',
    args: [],
    options: ['after', 'queue-id'],
    mutates: false,
    run: ({ client, values }) =>
      client.json(
        query(
          '/fixtures',
          FixtureQuery.parse({ after: text(values, 'after'), queueId: text(values, 'queue-id') }),
        ),
        FixturePage,
      ),
  },
  {
    name: 'fixtures retry',
    summary: 'Retry cleanup only after confirming old execution and backend requests stopped',
    args: ['id'],
    options: ['confirmed-stopped'],
    mutates: true,
    run: ({ client, args, values }) =>
      client.json(
        `/fixtures/${DbIdParam.parse(args[0])}/retry`,
        z.null(),
        FixtureRetryBody.parse({ confirmedStopped: values['confirmed-stopped'] }),
      ),
  },
]

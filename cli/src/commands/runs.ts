import {
  AttemptPage,
  CreatedRun,
  CreateRunBody,
  DbIdParam,
  ManifestPage,
  ManifestQuery,
  RunAgainBody,
  RunDetail,
  RunList,
  RunListQuery,
} from '@nowait/shared'
import { z } from 'zod'
import { query } from '../client.ts'
import { type Command, text } from '../command.ts'
import { readInput } from '../input.ts'
import { waitFor } from '../wait.ts'

const runInput = CreateRunBody.strict()

export const runs: Command[] = [
  {
    name: 'runs list',
    summary: 'Read one page of runs; continue with older as --before',
    args: [],
    options: ['before', 'status', 'query', 'limit'],
    mutates: false,
    run: ({ client, values }) =>
      client.json(
        query(
          '/runs',
          RunListQuery.parse({
            before: text(values, 'before'),
            status: text(values, 'status'),
            q: text(values, 'query'),
            limit: text(values, 'limit'),
          }),
        ),
        RunList,
      ),
  },
  {
    name: 'runs show',
    summary: 'Read a run, final scenario outcomes, coverage and release gate',
    args: ['id'],
    options: [],
    mutates: false,
    run: ({ client, args }) => client.json(`/runs/${DbIdParam.parse(args[0])}`, RunDetail),
  },
  {
    name: 'runs start',
    summary: 'Create one run from a CreateRunBody JSON file; never auto-retried',
    args: [],
    options: ['input'],
    inputSchema: runInput,
    mutates: true,
    run: async ({ client, values }) =>
      client.json('/runs', CreatedRun, await readInput(text(values, 'input'), runInput)),
  },
  {
    name: 'runs retry',
    summary: 'Create a new run from a finished run, optionally only failed scenarios',
    args: ['id'],
    options: ['failed'],
    mutates: true,
    run: ({ client, args, values }) =>
      client.json(
        `/runs/${DbIdParam.parse(args[0])}/again`,
        CreatedRun,
        RunAgainBody.parse({ failedOnly: values.failed === true }),
      ),
  },
  {
    name: 'runs cancel',
    summary: 'Cancel open scenarios of a run',
    args: ['id'],
    options: [],
    mutates: true,
    run: ({ client, args }) =>
      client.json(`/runs/${DbIdParam.parse(args[0])}/cancel`, z.null(), {}),
  },
  {
    name: 'runs attempts',
    summary: 'Read one page of attempts, including retained error and evidence availability',
    args: ['id'],
    options: ['page'],
    mutates: false,
    run: ({ client, args, values }) =>
      client.json(
        query(
          `/runs/${DbIdParam.parse(args[0])}/attempts`,
          ManifestQuery.parse({ page: text(values, 'page') }),
        ),
        AttemptPage,
      ),
  },
  {
    name: 'runs failures',
    summary:
      'Failed attempts on one page (including earlier failures of later-passing scenarios); follow next even when empty',
    args: ['id'],
    options: ['page'],
    mutates: false,
    run: async ({ client, args, values }) => {
      const page = await client.json(
        query(
          `/runs/${DbIdParam.parse(args[0])}/attempts`,
          ManifestQuery.parse({ page: text(values, 'page') }),
        ),
        AttemptPage,
      )
      return { ...page, attempts: page.attempts.filter((attempt) => attempt.status === 'failed') }
    },
  },
  {
    name: 'runs manifest',
    summary: 'Read verified input provenance and one page of attempt runtimes',
    args: ['id'],
    options: ['page'],
    mutates: false,
    run: ({ client, args, values }) =>
      client.json(
        query(
          `/runs/${DbIdParam.parse(args[0])}/manifest`,
          ManifestQuery.parse({ page: text(values, 'page') }),
        ),
        ManifestPage,
      ),
  },
  {
    name: 'runs wait',
    summary: 'Observe until terminal: exit 5 on failed run/rejected gate, 4 on deadline',
    args: ['id'],
    options: ['timeout'],
    mutates: false,
    run: ({ client, args, values, signal }) => {
      const path = `/runs/${DbIdParam.parse(args[0])}`
      return waitFor(
        (deadline) => client.json(path, RunDetail, undefined, deadline),
        (run) => run.status === 'running',
        (run) => run.status === 'passed' && run.release?.gate.status === 'accepted',
        text(values, 'timeout'),
        signal,
      )
    },
  },
]

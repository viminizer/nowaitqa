import {
  DbIdParam,
  SetupCreateBody,
  SetupCreated,
  SetupHostsPage,
  SetupHostsQuery,
  SetupJob,
  SetupResolveBody,
  SetupTargetsPage,
  SetupTargetsQuery,
} from '@nowait/shared'
import { z } from 'zod'
import { query } from '../client.ts'
import { type Command, text } from '../command.ts'
import { waitFor } from '../wait.ts'

export const setup: Command[] = [
  {
    name: 'setup hosts',
    summary: 'Discover runner machines before device registration; follow next',
    args: [],
    options: ['after'],
    mutates: false,
    run: ({ client, values }) =>
      client.json(
        query('/virtual/hosts', SetupHostsQuery.parse({ after: text(values, 'after') })),
        SetupHostsPage,
      ),
  },
  {
    name: 'setup targets',
    summary: 'List installed targets without booting; follow next',
    args: [],
    options: ['host', 'after'],
    mutates: false,
    run: ({ client, values }) =>
      client.json(
        query(
          '/virtual/targets',
          SetupTargetsQuery.parse({ host: text(values, 'host'), after: text(values, 'after') }),
        ),
        SetupTargetsPage,
      ),
  },
  {
    name: 'setup start',
    summary: 'Register an installed target; --boot explicitly permits headless cold boot',
    args: [],
    options: ['host', 'key', 'boot'],
    mutates: true,
    run: ({ client, values }) =>
      client.json(
        '/virtual/jobs',
        SetupCreated,
        SetupCreateBody.parse({
          host: text(values, 'host'),
          key: text(values, 'key'),
          boot: values.boot === true,
        }),
      ),
  },
  {
    name: 'setup show',
    summary: 'Read durable setup progress and recovery state',
    args: ['id'],
    options: [],
    mutates: false,
    run: ({ client, args }) => client.json(`/virtual/jobs/${DbIdParam.parse(args[0])}`, SetupJob),
  },
  {
    name: 'setup cancel',
    summary: 'Request cancellation; an explicitly started VM may remain running',
    args: ['id'],
    options: [],
    mutates: true,
    run: ({ client, args }) =>
      client.json(`/virtual/jobs/${DbIdParam.parse(args[0])}/cancel`, z.null(), {}),
  },
  {
    name: 'setup resolve',
    summary: 'Release an interrupted hold only after confirming old commands stopped',
    args: ['id'],
    options: ['confirmed-stopped'],
    mutates: true,
    run: ({ client, args, values }) =>
      client.json(
        `/virtual/jobs/${DbIdParam.parse(args[0])}/resolve`,
        z.null(),
        SetupResolveBody.parse({ confirmedStopped: values['confirmed-stopped'] }),
      ),
  },
  {
    name: 'setup wait',
    summary: 'Observe setup until terminal; interrupted setup exits 5 without releasing its hold',
    args: ['id'],
    options: ['timeout'],
    mutates: false,
    run: ({ client, args, values, signal }) =>
      waitFor(
        (deadline) =>
          client.json(`/virtual/jobs/${DbIdParam.parse(args[0])}`, SetupJob, undefined, deadline),
        (job) => ['queued', 'active'].includes(job.status),
        (job) => job.status === 'succeeded',
        text(values, 'timeout'),
        signal,
      ),
  },
]

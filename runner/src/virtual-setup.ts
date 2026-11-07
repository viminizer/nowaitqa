// The host channel exists before its first device registration. One nonce owns each setup.
import { randomUUID } from 'node:crypto'
import {
  every,
  type SetupAuthority,
  type SetupClaim,
  type SetupStage,
  type VirtualInventory,
} from '@nowait/shared'
import {
  getDevices,
  setupClaim,
  setupContact,
  setupFinish,
  setupProgress,
  setupRelease,
  setupReserve,
} from './api.ts'
import { config } from './config.ts'
import { log } from './log.ts'
import {
  bootVirtual,
  chooseAndroidSerial,
  chooseSystemPort,
  discoverVirtual,
  preflightVirtual,
  requireAndroidPorts,
  SetupToolError,
  waitVirtual,
} from './virtual-tools.ts'

export function startVirtualSetup(shutdown: AbortSignal) {
  const owner = { host: config.HOST, session: randomUUID() }
  let inventory: VirtualInventory | undefined
  let scannedAt = 0,
    publishedRevision: string | undefined
  let accepted = false,
    blocked = false,
    notedUnavailable = false
  let active:
    | {
        authority: SetupAuthority
        controller: AbortController
        deadline: ReturnType<typeof setTimeout>
      }
    | undefined
  let working: Promise<void> | undefined
  const logger = { error: (err: unknown, message: string) => log(config.HOST, message, err) }
  const resetAuthorityDeadline = (current: NonNullable<typeof active>, requestStarted: number) => {
    clearTimeout(current.deadline)
    // Server ownership lasts 60s. Stop after 40s from request START, leaving time for group
    // termination (5s) and the final report (10s), even if a contact response was delayed.
    current.deadline = setTimeout(
      () => current.controller.abort(new SetupToolError('owner_lost')),
      Math.max(0, requestStarted + 40_000 - performance.now()),
    )
  }
  const contact = every(
    15_000,
    'setup host contact',
    async (signal) => {
      const current = active
      const started = performance.now()
      const sentRevision = inventory?.revision
      const reply = await setupContact(
        {
          ...owner,
          os: process.platform === 'darwin' ? 'darwin' : 'linux',
          appiumUrl: config.APPIUM_URL,
          inventory,
          ...(current
            ? { active: { id: current.authority.id, claim: current.authority.claim } }
            : {}),
        },
        signal,
      )
      accepted = typeof reply !== 'number'
      if (!accepted) {
        if (!notedUnavailable) {
          notedUnavailable = true
          log(
            config.HOST,
            reply === 404
              ? 'guided setup requires a newer server; manual devices remain supported'
              : 'another runner owns guided setup for this HOST; use a unique HOST or stop that runner',
          )
        }
        current?.controller.abort(new SetupToolError('owner_lost'))
        return
      }
      if (typeof reply === 'number') return
      publishedRevision = sentRevision
      if (current && active === current) {
        if (reply.cancelRequested) current.controller.abort(new SetupToolError('cancelled'))
        else if (!reply.jobAlive) current.controller.abort(new SetupToolError('owner_lost'))
        else resetAuthorityDeadline(current, started)
      }
    },
    logger,
  )
  const discovery = every(
    5_000,
    'virtual device discovery',
    async (signal) => {
      if (!accepted || blocked || (inventory && performance.now() - scannedAt < 60_000)) return
      try {
        inventory = await discoverVirtual(signal)
        scannedAt = performance.now()
      } catch (err) {
        if (err instanceof SetupToolError && !err.stopped) {
          blocked = true
          inventory = { revision: randomUUID(), targets: [], issues: ['command_unconfirmed'] }
        }
        throw err
      }
    },
    logger,
  )

  async function perform(job: SetupClaim, claimedAt: number, shutdownSignal: AbortSignal) {
    const controller = new AbortController()
    const authority = { ...owner, id: job.id, claim: job.claim }
    const current = { authority, controller, deadline: setTimeout(() => {}, 0) }
    active = current
    resetAuthorityDeadline(current, claimedAt)
    // 420s is below the server's 450s maximum, allowing stop and finish before expiry (R34).
    const signal = AbortSignal.any([
      controller.signal,
      shutdownSignal,
      AbortSignal.timeout(420_000),
    ])
    let stopped = true
    const progress = async (stage: SetupStage) => {
      if (!(await setupProgress({ ...authority, stage }, signal)))
        throw new SetupToolError('cancelled')
    }
    try {
      await progress('checking')
      const fresh = await discoverVirtual(signal)
      const target = fresh.targets.find((t) => t.key === job.target.key)
      if (!target || target.issue || target.state === 'unavailable')
        throw new SetupToolError(target?.issue ?? 'runtime_unavailable')
      if (!job.boot && target.state === 'stopped') throw new SetupToolError('not_running')
      const phones = await getDevices(signal)
      const existing = job.existing
      if (
        existing &&
        (existing.appiumUrl !== config.APPIUM_URL || existing.platform !== target.platform)
      )
        throw new SetupToolError('registration_conflict')
      await preflightVirtual(target.platform, signal)
      const udid = target.udid ?? existing?.udid ?? (await chooseAndroidSerial(phones, signal))
      if (existing && existing.udid !== udid) throw new SetupToolError('registration_conflict')
      const systemPort =
        existing?.systemPort ?? (await chooseSystemPort(target.platform, phones, signal))
      if (!(await setupReserve({ ...authority, udid, systemPort }, signal)))
        throw new SetupToolError('port_conflict')
      if (target.state === 'stopped') {
        if (target.platform === 'android') await requireAndroidPorts(udid, signal)
        await progress('starting')
        await bootVirtual(target, udid, signal)
      }
      await progress('waiting')
      const version = await waitVirtual(target, udid, signal)
      if (existing?.platformVersion && existing.platformVersion !== version)
        throw new SetupToolError('registration_conflict')
      await progress('registering')
      await setupFinish({ ...authority, status: 'succeeded', stopped, version })
      log(config.HOST, `virtual device setup ${job.id} completed`)
    } catch (err) {
      if (err instanceof SetupToolError) stopped = err.stopped
      const cause = signal.aborted ? signal.reason : err
      const reason = !stopped
        ? 'command_unconfirmed'
        : cause instanceof SetupToolError
          ? cause.reason
          : signal.aborted
            ? shutdownSignal.aborted
              ? 'cancelled'
              : 'timeout'
            : 'setup_failed'
      if (!stopped) blocked = true
      try {
        await setupFinish({
          ...authority,
          status: reason === 'cancelled' ? 'cancelled' : 'failed',
          reason,
          stopped,
        })
      } catch {
        // A lost final response is never replayed into another boot. The server retains its hold.
        blocked = true
        log(
          config.HOST,
          `setup ${job.id} final report unconfirmed; inspect its server status before restarting guided setup`,
        )
      }
      log(config.HOST, `virtual device setup ${job.id}: ${reason}`)
    } finally {
      clearTimeout(current.deadline)
      active = undefined
      inventory = undefined // Discover the state left by boot/cancel before any new request.
      publishedRevision = undefined
    }
  }
  const claims = every(
    5_000,
    'virtual setup claim',
    async (signal) => {
      if (!accepted || blocked || !inventory || publishedRevision !== inventory.revision) return
      const started = performance.now()
      const job = await setupClaim(owner, signal)
      if (!job) return
      working = perform(job, started, signal)
      await working
      working = undefined
    },
    logger,
  )
  const stop = async () => {
    claims()
    discovery()
    // Keep contact running until owned commands stop and their final report has been attempted.
    await working
    contact()
    try {
      await setupRelease(owner)
    } catch {
      log(config.HOST, 'setup host release unconfirmed; server expiry retains any unresolved hold')
    }
  }
  shutdown.addEventListener(
    'abort',
    () => {
      void stop()
    },
    { once: true },
  )
  if (shutdown.aborted) void stop()
}

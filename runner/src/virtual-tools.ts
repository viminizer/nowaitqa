// Discovery never boots a VM. Commands are argv-only, bounded and owned until their groups stop.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type Device,
  RuntimeVersion,
  type SetupReason,
  VIRTUAL_TARGET_LIMIT,
  VirtualInventory,
  type VirtualTarget,
} from '@nowait/shared'
import { z } from 'zod'
import { config } from './config.ts'
import { stopExecutor } from './executor.ts'

export class SetupToolError extends Error {
  constructor(
    readonly reason: SetupReason,
    readonly stopped = true,
  ) {
    super(reason)
  }
}

export async function setupCommand(
  bin: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 20_000,
) {
  signal.throwIfAborted()
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(timeoutMs)])
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '',
    bytes = 0
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1_048_576) controller.abort(new SetupToolError('inventory_invalid'))
      else if (stream === child.stdout) output += chunk.toString('utf8')
    })
  let failed = false
  const exited = new Promise<void>((resolve) => {
    child.once('error', () => {
      failed = true
      resolve()
    })
    child.once('close', (code) => {
      failed ||= code !== 0
      resolve()
    })
  })
  let abort: (() => void) | undefined
  let commandError: unknown
  let stopped = false
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        abort = () => reject(combined.reason)
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) abort()
      }),
    ])
  } catch (err) {
    commandError = err
  } finally {
    if (abort) combined.removeEventListener('abort', abort)
    // Includes descendants left behind after an ordinary command exited.
    stopped = await stopExecutor(child, exited, config.HOST)
  }
  if (!stopped) throw new SetupToolError('command_unconfirmed', false)
  if (commandError) throw commandError
  combined.throwIfAborted()
  if (failed) throw new SetupToolError('setup_failed')
  return output.trim()
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
const avdName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const adb = (args: string[], signal: AbortSignal) => setupCommand(config.ADB_BIN, args, signal)
const simctl = (args: string[], signal: AbortSignal) =>
  setupCommand(config.XCRUN_BIN, ['simctl', ...args], signal)

async function androidRuntime(name: string) {
  // Bounded file read; the canonical name cannot escape ANDROID_AVD_HOME.
  try {
    const file = await open(join(config.ANDROID_AVD_HOME, `${name}.ini`), 'r')
    try {
      const buffer = Buffer.alloc(16_384)
      const { bytesRead } = await file.read(buffer)
      const target = /^target=android-(\d+)\s*$/m.exec(buffer.subarray(0, bytesRead).toString())
      return target ? `Android API ${target[1]}` : 'Android (version checked at setup)'
    } finally {
      await file.close()
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return 'Android (version checked at setup)'
    throw new SetupToolError('android_tools')
  }
}
async function discoverAndroid(signal: AbortSignal): Promise<VirtualTarget[]> {
  const listed = lines(await setupCommand(config.EMULATOR_BIN, ['-list-avds'], signal))
  if (listed.length > VIRTUAL_TARGET_LIMIT) throw new SetupToolError('inventory_limit')
  const names = z.array(avdName).parse(listed)
  if (new Set(names).size !== names.length) throw new SetupToolError('inventory_invalid')
  const transports = lines(await adb(['devices'], signal)).filter((s) => s.startsWith('emulator-'))
  const running = new Map<string, string[]>()
  let ambiguous = false
  for (const row of transports) {
    const [serial, state] = row.split(/\s+/)
    if (!serial || !/^emulator-\d+$/.test(serial) || state !== 'device') {
      ambiguous = true
      continue
    }
    const name = lines(await adb(['-s', serial, 'emu', 'avd', 'name'], signal))[0]
    if (!name || !names.includes(name)) {
      ambiguous = true
      continue
    }
    running.set(name, [...(running.get(name) ?? []), serial])
  }
  const targets: VirtualTarget[] = []
  for (const name of names) {
    const matches = running.get(name) ?? []
    const udid = matches.length === 1 ? (matches[0] ?? null) : null
    const issue = matches.length > 1 || (!udid && ambiguous) ? 'identity_ambiguous' : null
    let state: VirtualTarget['state'] = issue ? 'unavailable' : udid ? 'starting' : 'stopped'
    let runtime = await androidRuntime(name)
    if (udid) {
      if ((await adb(['-s', udid, 'shell', 'getprop', 'sys.boot_completed'], signal)) === '1') {
        runtime = RuntimeVersion.parse(
          await adb(['-s', udid, 'shell', 'getprop', 'ro.build.version.release'], signal),
        )
        state = 'running'
      }
    }
    targets.push({
      key: `android:${name}`,
      platform: 'android',
      identifier: name,
      name: name.replaceAll('_', ' '),
      runtime,
      udid,
      state,
      issue,
    })
  }
  return targets
}
const SimulatorList = z.object({
  runtimes: z
    .array(
      z.object({
        identifier: z.string(),
        name: z.string(),
        version: RuntimeVersion,
        isAvailable: z.boolean(),
      }),
    )
    .max(100),
  devices: z.record(
    z.string(),
    z
      .array(
        z.object({
          udid: z.uuid(),
          name: z.string().min(1).max(255),
          state: z.string(),
          isAvailable: z.boolean(),
        }),
      )
      .max(VIRTUAL_TARGET_LIMIT),
  ),
})
async function discoverIos(signal: AbortSignal): Promise<VirtualTarget[]> {
  const list = SimulatorList.parse(JSON.parse(await simctl(['list', '-j'], signal)))
  const targets: VirtualTarget[] = []
  for (const [runtimeId, devices] of Object.entries(list.devices)) {
    if (!runtimeId.includes('.iOS-')) continue
    const runtime = list.runtimes.find((r) => r.identifier === runtimeId)
    for (const device of devices) {
      const available = runtime?.isAvailable && device.isAvailable
      const state = !available
        ? 'unavailable'
        : device.state === 'Booted'
          ? 'running'
          : device.state === 'Booting'
            ? 'starting'
            : device.state === 'Shutdown'
              ? 'stopped'
              : 'unavailable'
      targets.push({
        key: `ios:${device.udid}`,
        platform: 'ios',
        identifier: device.udid,
        name: device.name,
        runtime: runtime?.version ?? runtimeId.slice(0, 255),
        udid: device.udid,
        state,
        issue: available && state !== 'unavailable' ? null : 'runtime_unavailable',
      })
      if (targets.length > VIRTUAL_TARGET_LIMIT) throw new SetupToolError('inventory_limit')
    }
  }
  return targets
}
export async function discoverVirtual(
  signal: AbortSignal,
  os = process.platform,
): Promise<VirtualInventory> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const inventory: VirtualInventory = { revision: randomUUID(), targets: [], issues: [] }
  for (const platform of ['android', 'ios'] as const) {
    if (platform === 'ios' && os !== 'darwin') {
      inventory.issues.push('ios_unsupported')
      continue
    }
    try {
      inventory.targets.push(
        ...(await (platform === 'android' ? discoverAndroid(bounded) : discoverIos(bounded))),
      )
    } catch (err) {
      if (err instanceof SetupToolError && !err.stopped) throw err
      signal.throwIfAborted()
      inventory.issues.push(
        err instanceof SetupToolError && err.reason !== 'setup_failed'
          ? err.reason
          : err instanceof z.ZodError
            ? 'inventory_invalid'
            : platform === 'android'
              ? 'android_tools'
              : 'xcode_tools',
      )
    }
  }
  if (inventory.targets.length > VIRTUAL_TARGET_LIMIT) {
    inventory.targets = []
    inventory.issues.push('inventory_limit')
  }
  return VirtualInventory.parse(inventory)
}

export async function preflightVirtual(platform: VirtualTarget['platform'], signal: AbortSignal) {
  const url = new URL(`${config.APPIUM_URL.replace(/\/$/, '')}/status`)
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
    const body = z.object({ value: z.object({ ready: z.literal(true) }) }).parse(await res.json())
    if (!res.ok || !body.value.ready) throw new SetupToolError('appium_unavailable')
  } catch (err) {
    signal.throwIfAborted()
    throw err instanceof SetupToolError ? err : new SetupToolError('appium_unavailable')
  }
  try {
    const drivers = z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(
          await setupCommand(
            config.APPIUM_BIN,
            ['driver', 'list', '--installed', '--json'],
            signal,
          ),
        ),
      )
    if (!Object.hasOwn(drivers, platform === 'android' ? 'uiautomator2' : 'xcuitest'))
      throw new SetupToolError('driver_missing')
  } catch (err) {
    if (err instanceof SetupToolError && !err.stopped) throw err
    signal.throwIfAborted()
    throw new SetupToolError('driver_missing')
  }
}
async function freePort(port: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    )
  })
}
export async function chooseSystemPort(
  platform: VirtualTarget['platform'],
  phones: Device[],
  signal: AbortSignal,
) {
  const used = new Set(
    phones.flatMap((p) =>
      p.platform === 'ios' ? [p.systemPort, p.systemPort + 1] : [p.systemPort],
    ),
  )
  const start = platform === 'android' ? 8200 : 8100
  for (let port = start; port < start + 100; port += platform === 'ios' ? 2 : 1) {
    if (used.has(port) || (platform === 'ios' && used.has(port + 1))) continue
    if (
      (await freePort(port, signal)) &&
      (platform !== 'ios' || (await freePort(port + 1, signal)))
    )
      return port
  }
  throw new SetupToolError('port_conflict')
}
export async function chooseAndroidSerial(phones: Device[], signal: AbortSignal) {
  const used = new Set(phones.map((p) => p.udid))
  for (let port = 5554; port <= 5682; port += 2) {
    if (used.has(`emulator-${port}`)) continue
    if ((await freePort(port, signal)) && (await freePort(port + 1, signal)))
      return `emulator-${port}`
  }
  throw new SetupToolError('port_conflict')
}
export async function bootVirtual(target: VirtualTarget, udid: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (target.platform === 'ios') {
    await simctl(['boot', target.identifier], signal)
    return
  }
  // This is the user's explicitly requested VM, not a transient setup command. It stays running
  // on cancellation or runner exit. Never launch Simulator.app or an Android emulator window.
  const child = spawn(
    config.EMULATOR_BIN,
    ['-avd', target.identifier, '-port', udid.slice(9), '-no-window', '-no-audio'],
    { detached: true, stdio: 'ignore' },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new SetupToolError('android_tools')))
    child.once('spawn', resolve)
  })
  child.unref()
}
export async function waitVirtual(target: VirtualTarget, udid: string, signal: AbortSignal) {
  if (target.platform === 'ios') {
    // Observe only: -b would also boot a device stopped after a Register request.
    await setupCommand(
      config.XCRUN_BIN,
      ['simctl', 'bootstatus', target.identifier],
      signal,
      180_000,
    )
    const fresh = (await discoverVirtual(signal)).targets.find((t) => t.key === target.key)
    if (fresh?.state !== 'running' || fresh.udid !== udid || fresh.issue)
      throw new SetupToolError(fresh?.issue ?? 'runtime_unavailable')
    return RuntimeVersion.parse(fresh.runtime)
  }
  // A just-started emulator normally appears as offline before ADB is ready. Its reserved
  // serial may be waited for, but never registered until its canonical AVD identity is known.
  for (;;) {
    signal.throwIfAborted()
    const transports = lines(await adb(['devices'], signal))
    const connected = transports.some((row) => {
      const [serial, state] = row.split(/\s+/)
      return serial === udid && state === 'device'
    })
    if (connected) {
      const name = lines(await adb(['-s', udid, 'emu', 'avd', 'name'], signal))[0]
      if (name !== target.identifier) throw new SetupToolError('identity_ambiguous')
      if ((await adb(['-s', udid, 'shell', 'getprop', 'sys.boot_completed'], signal)) === '1') {
        const fresh = (await discoverVirtual(signal)).targets.find((t) => t.key === target.key)
        if (fresh?.issue || fresh?.udid !== udid || fresh.state !== 'running')
          throw new SetupToolError(fresh?.issue ?? 'identity_ambiguous')
        return RuntimeVersion.parse(fresh.runtime)
      }
    }
    await sleep(1_000, undefined, { signal })
  }
}

export async function requireAndroidPorts(udid: string, signal: AbortSignal) {
  const port = Number(udid.slice(9))
  if (
    port < 5554 ||
    port > 5682 ||
    port % 2 ||
    !(await freePort(port, signal)) ||
    !(await freePort(port + 1, signal))
  )
    throw new SetupToolError('port_conflict')
}

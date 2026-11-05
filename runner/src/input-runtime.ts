import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { Device, InputRuntime } from '@nowait/shared'
import type { Browser } from 'webdriverio'
import { z } from 'zod'
import { log } from './log.ts'

const require = createRequire(import.meta.url)
const Version = z.object({ version: z.string().max(100) })
const runner = Version.parse(
  JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')),
).version
const webdriver = Version.parse(
  JSON.parse(
    await readFile(resolve(dirname(require.resolve('webdriverio')), '../package.json'), 'utf8'),
  ),
).version

export async function inputRuntime(
  device: Device,
  driver: Browser,
  signal: AbortSignal,
): Promise<InputRuntime> {
  const caps = driver.capabilities as Record<string, unknown>
  const text = (value: unknown) => z.string().max(100).safeParse(value).data ?? null
  let appium: string | null = null
  try {
    const url = new URL(device.appiumUrl)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/status`
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    })
    if (!response.ok) throw new Error(`Appium status returned ${response.status}`)
    const data = z.object({ value: z.object({ build: Version }) }).parse(await response.json())
    appium = data.value.build.version
  } catch (err) {
    signal.throwIfAborted()
    log(
      device.name,
      'Appium version observation unavailable',
      err instanceof Error ? err.name : 'unknown error',
    )
  }
  return {
    node: process.version,
    runner,
    webdriver,
    appium,
    automation: text(caps['appium:automationName'] ?? caps.automationName),
    driver: text(caps['appium:driverVersion'] ?? caps.driverVersion),
    platformVersion: text(caps.platformVersion ?? caps['appium:platformVersion']),
  }
}

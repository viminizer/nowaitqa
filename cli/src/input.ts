import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { z } from 'zod'
import { CliError } from './output.ts'

export async function readInput<T>(path: string | undefined, schema: z.ZodType<T>) {
  if (!path) throw new CliError('invalid_arguments', '--input FILE is required', 2)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new CliError('invalid_input', 'Input must be a regular JSON file of at most 1 MiB', 2)
    const buffer = Buffer.alloc(1024 * 1024 + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (part.bytesRead === 0) break
      bytesRead += part.bytesRead
    }
    if (bytesRead > 1024 * 1024) throw new CliError('invalid_input', 'Input exceeds 1 MiB', 2)
    let value: unknown
    try {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    } catch {
      throw new CliError('invalid_input', 'Input is not valid JSON', 2)
    }
    return schema.parse(value)
  } catch (err) {
    if (err instanceof CliError || (err instanceof Error && err.name === 'ZodError')) throw err
    throw new CliError('input_unavailable', 'Cannot read the input file', 2)
  } finally {
    await file?.close()
  }
}

export async function saveDownload(path: string | undefined, bytes: Buffer) {
  if (!path) throw new CliError('invalid_arguments', '--output FILE is required', 2)
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'wx', 0o600)
  } catch {
    throw new CliError(
      'output_unavailable',
      'Cannot create output file; existing files are never overwritten',
      2,
    )
  }
  try {
    await file.writeFile(bytes)
  } catch {
    await file.close()
    await unlink(path)
    throw new CliError('output_failed', 'Cannot finish writing the output file')
  }
  await file.close()
  return {
    path: resolve(path),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

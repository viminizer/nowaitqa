// Resolve bytes where the runner and Appium share a filesystem. Never infer remote file identity.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Device } from '@nowait/shared'
import { config } from './config.ts'
import { log } from './log.ts'

const exec = promisify(execFile)

// NUL-delimited Git output can contain arbitrary filenames and exceed execFile's buffer.
async function* gitRecords(root: string, args: string[], signal?: AbortSignal) {
  const child = spawn('git', args, { cwd: root, signal, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8192)
  })
  let failure: Error | undefined
  child.once('error', (error) => {
    failure = error
  })
  const finished = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('close', (code) => resolve({ code, error: failure }))
  })
  try {
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      let end = pending.indexOf('\0')
      while (end !== -1) {
        const record = pending.slice(0, end)
        pending = pending.slice(end + 1)
        yield record
        end = pending.indexOf('\0')
      }
    }
    const result = await finished
    signal?.throwIfAborted()
    if (result.error) throw result.error
    if (result.code !== 0) throw new Error(`cannot inspect scenario checkout: ${stderr}`)
    if (pending) throw new Error('incomplete scenario checkout inventory')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await finished
  }
}
export async function scenarioIdentity(dir: string, commit: string, signal?: AbortSignal) {
  dir = await realpath(dir)
  const git = async (...args: string[]) =>
    (await exec('git', args, { cwd: dir, signal })).stdout.trim()
  if ((await git('rev-parse', 'HEAD')) !== commit) throw new Error('scenario checkout HEAD changed')
  const root = await realpath(await git('rev-parse', '--show-toplevel'))
  const packageFiles: string[] = []
  for (let folder = dir; ; folder = dirname(folder)) {
    for (const file of ['package.json', 'pnpm-lock.yaml']) {
      const path = join(folder, file)
      if (!packageFiles.some((p) => basename(p) === file)) {
        try {
          await lstat(path)
          packageFiles.push(path)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
    }
    if (folder === root) break
    if (dirname(folder) === folder) throw new Error('scenario directory is outside its checkout')
  }
  // Helpers may be imported from sibling folders. The identity covers the checkout, not only
  // the discovery folder; dependency declarations elsewhere in the repo are included too.
  const clean = async () => {
    if ((await git('rev-parse', 'HEAD')) !== commit)
      throw new Error('scenario checkout HEAD changed')
    const dirty = await git(
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
      '--ignore-submodules=none',
    )
    if (dirty)
      throw new Error(
        'scenario source or dependency declarations are dirty; commit changes before running',
      )
    for await (const path of gitRecords(
      root,
      [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
        ':(exclude,glob)**/node_modules/**',
      ],
      signal,
    )) {
      if (
        config.SCENARIOS_REPO &&
        dirname(path) === '.' &&
        ['.nowait-ready', '.nowait-ready.tmp'].includes(path)
      )
        continue
      throw new Error('scenario source contains uncommitted files; commit changes before running')
    }
  }
  await clean()
  // Git records link text; an outside referent could change without changing that text.
  for await (const record of gitRecords(root, ['ls-files', '--stage', '-v', '-z'], signal)) {
    if (record[0] !== 'H')
      throw new Error(
        'scenario checkout has hidden index state; clear skip-worktree/assume-unchanged flags before verification',
      )
    const entry = record.slice(2)
    if (entry.startsWith('160000 '))
      throw new Error(
        'scenario source submodules cannot be verified; use a self-contained checkout',
      )
    if (!entry.startsWith('120000 ')) continue
    const target = await realpath(join(root, entry.slice(entry.indexOf('\t') + 1)))
    if (target !== root && !target.startsWith(root + sep))
      throw new Error('scenario source symlink escapes its checkout')
  }
  const generated = createHash('sha256')
  let generatedBytes = 0
  let generatedFiles = 0
  const privateInfo = resolve(dir, await git('rev-parse', '--git-path', 'info/exclude'))
  const privateMetadata = async (path: string) => {
    const rule = (
      await exec('git', ['check-ignore', '-v', '--', path], { cwd: root, signal })
    ).stdout.match(/^(.*?):\d+:/)
    const source = rule?.[1]
    if (!source) return false
    const origin = resolve(root, source)
    return origin === privateInfo || !origin.startsWith(root + sep)
  }
  for await (const path of gitRecords(
    root,
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      '.',
      ':(exclude,glob)**/node_modules/**',
      ':(exclude,glob)**/node_modules',
    ],
    signal,
  )) {
    const file = join(root, path)
    const metadata = await lstat(file)
    if (metadata.isDirectory()) {
      if (await privateMetadata(path)) continue
      throw new Error('ignored nested checkout cannot be verified as scenario source')
    }
    const code =
      [
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.node',
        '.wasm',
        '.py',
        '.rb',
        '.sh',
        '.bash',
        '.zsh',
        '.lua',
        '.pl',
      ].includes(extname(path)) ||
      (!extname(path) && !basename(path).startsWith('.')) ||
      (!metadata.isSymbolicLink() && (metadata.mode & 0o111) !== 0)
    if (metadata.isSymbolicLink()) {
      const target = await realpath(file)
      if (target !== root && !target.startsWith(root + sep)) {
        const data =
          !code &&
          !(await lstat(target)).isDirectory() &&
          ([
            '.md',
            '.txt',
            '.json',
            '.yaml',
            '.yml',
            '.log',
            '.pem',
            '.key',
            '.crt',
            '.png',
            '.jpg',
          ].includes(extname(path)) ||
            basename(path) === '.env' ||
            basename(path).startsWith('.env.'))
        if (data) continue // ignored non-code configuration is outside the source record
        // Operator-private Git excludes describe metadata, unlike project .gitignore source
        // generation. Keep those metadata links private; executable code must not live there.
        if (!code) {
          if (await privateMetadata(path)) continue
        }
        throw new Error('ignored source symlink escapes its checkout')
      }
      if (!code || (await lstat(target)).isDirectory()) {
        const link = JSON.stringify([path, 'link', await readlink(file)])
        generated.update(`${Buffer.byteLength(link)}:`).update(link)
        continue
      }
    }
    if (!code) continue
    if (++generatedFiles > 100_000) throw new Error('too many ignored executable source files')
    const name = JSON.stringify([
      path,
      metadata.mode & 0o111,
      metadata.isSymbolicLink() ? await readlink(file) : null,
    ])
    generated.update(`${Buffer.byteLength(name)}:`).update(name)
    const content = createHash('sha256')
    for await (const chunk of createReadStream(file, { signal })) {
      generatedBytes += chunk.length
      if (generatedBytes > config.INPUT_MAX_BYTES)
        throw new Error('ignored executable source exceeds INPUT_MAX_BYTES')
      content.update(chunk)
    }
    generated.update(content.digest())
  }
  const hashFile = async (name: string) => {
    const file = packageFiles.find((p) => basename(p) === name)
    return file
      ? createHash('sha256')
          .update(await readFile(file, { signal }))
          .digest('hex')
      : null
  }
  const identity = {
    commit,
    tree: await git('rev-parse', `${commit}^{tree}`),
    directory: relative(root, dir).split(sep).join('/') || '.',
    packageSha256: await hashFile('package.json'),
    lockSha256: await hashFile('pnpm-lock.yaml'),
    ignoredCodeSha256: generated.digest('hex'),
  }
  await clean()
  return identity
}

// Length framing separates names, metadata and bytes. Paths are relative; timestamps/root names
// are excluded. Link targets are part of identity and may not escape the Simulator app bundle.
export async function appIdentity(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256')
  const supplied = resolve(path)
  const stat = await lstat(supplied)
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('unsupported app artifact root')
  const root = await realpath(supplied)
  let bytes = 0
  let entries = 0
  const frame = (value: string) => hash.update(`${Buffer.byteLength(value)}:`).update(value)
  const add = async (file: string, name: string) => {
    signal?.throwIfAborted()
    if (++entries > 100_000) throw new Error('app artifact contains too many entries')
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) {
      const target = await readlink(file)
      const resolved = await realpath(file)
      if (isAbsolute(target) || (resolved !== root && !resolved.startsWith(root + sep)))
        throw new Error('Simulator app contains an escaping symlink')
      frame(JSON.stringify([name, 'link', target]))
      return
    }
    if (stat.isDirectory()) {
      frame(JSON.stringify([name, 'directory']))
      for (const entry of (await readdir(file)).sort())
        await add(join(file, entry), name ? `${name}/${entry}` : entry)
      return
    }
    if (!stat.isFile()) throw new Error('unsupported app artifact entry')
    frame(JSON.stringify([name, 'file', stat.mode & 0o111, stat.size]))
    let actual = 0
    for await (const chunk of createReadStream(file, { signal })) {
      actual += chunk.length
      bytes += chunk.length
      if (bytes > config.INPUT_MAX_BYTES) throw new Error('app artifact exceeds INPUT_MAX_BYTES')
      hash.update(chunk)
    }
    if (actual !== stat.size) throw new Error('app artifact changed while hashing')
  }
  const directory = stat.isDirectory()
  if (directory) await add(root, '')
  else {
    // Files use the ordinary SHA256 of their bytes, directly comparable with CI digests.
    for await (const chunk of createReadStream(root, { signal })) {
      bytes += chunk.length
      if (bytes > config.INPUT_MAX_BYTES) throw new Error('app artifact exceeds INPUT_MAX_BYTES')
      hash.update(chunk)
    }
  }
  return {
    kind: directory ? ('simulator-app' as const) : ('archive' as const),
    sha256: hash.digest('hex'),
    bytes,
  }
}

export async function stageApp(source: string, device: Device, signal: AbortSignal) {
  const host = new URL(device.appiumUrl).hostname
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
    throw new Error(
      'app input unavailable: verified staging requires Appium to share the runner filesystem',
    )
  const folder = await mkdtemp(join(tmpdir(), 'nowait-app-'))
  const release = async () =>
    rm(folder, { recursive: true, force: true }).catch((err) =>
      log(device.name, 'could not remove staged app input', err),
    )
  try {
    const url = /^https?:\/\//i.test(source) ? new URL(source) : null
    const name = url
      ? /\.(apk|zip)$/i.test(url.pathname)
        ? basename(url.pathname)
        : device.platform === 'android'
          ? 'app.apk'
          : 'simulator.app.zip'
      : basename(source)
    if (!name || !/\.(apk|zip|app)$/i.test(name))
      throw new Error('app input must be an APK, ZIP or Simulator .app')
    const target = join(folder, name)
    if (url) {
      const res = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      })
      const body = res.body
      if (!res.ok || !body) throw new Error(`app input download failed (${res.status})`)
      let size = 0
      await writeFile(
        target,
        (async function* () {
          for await (const chunk of body) {
            size += chunk.length
            if (size > config.INPUT_MAX_BYTES)
              throw new Error('app artifact exceeds INPUT_MAX_BYTES')
            yield chunk
          }
        })(),
        { signal },
      )
    } else {
      // Check links/size before copying. Rehash the private snapshot after copying.
      const before = await appIdentity(source, signal)
      await cp(source, target, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        filter: () => {
          signal.throwIfAborted()
          return true
        },
      })
      const after = await appIdentity(target, signal)
      if (before.sha256 !== after.sha256) throw new Error('app artifact changed while staging')
    }
    const identity = await appIdentity(target, signal)
    return { path: target, identity, release }
  } catch (err) {
    await release()
    // Source URLs can carry signed credentials: never include the locator in an error.
    if (
      err instanceof Error &&
      /app input|app artifact|Simulator app|unsupported app/.test(err.message)
    )
      throw err
    throw new Error('app input unavailable: unable to resolve and stage the requested bytes')
  }
}

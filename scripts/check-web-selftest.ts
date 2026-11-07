import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWeb } from './check-web.ts'

const W = fileURLToPath(new URL('../', import.meta.url))
const R = mkdtempSync(join(tmpdir(), 'nowait-web-policy-'))
try {
  mkdirSync(join(R, 'web'), { recursive: true })
  cpSync(join(W, 'web/src'), join(R, 'web/src'), { recursive: true })
  for (const name of ['tsconfig.json', 'package.json', 'index.html'])
    cpSync(join(W, 'web', name), join(R, 'web', name))
  cpSync(join(W, 'package.json'), join(R, 'package.json'))
  symlinkSync(join(W, 'node_modules'), join(R, 'node_modules'), 'dir')
  symlinkSync(join(W, 'web/node_modules'), join(R, 'web/node_modules'), 'dir')
  const results: unknown[] = []
  assert.deepEqual(checkWeb(R), [])
  console.log('PASS clean fixture')
  const originals = new Map<string, string | null>()
  function set(path: string, text: string) {
    const full = join(R, path)
    if (!originals.has(full)) {
      try {
        originals.set(full, readFileSync(full, 'utf8'))
      } catch {
        originals.set(full, null)
      }
    }
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  function append(path: string, text: string) {
    set(path, `${readFileSync(join(R, path), 'utf8')}\n${text}`)
  }
  function restore() {
    for (const [path, text] of originals) {
      if (text === null) rmSync(path, { force: true })
      else writeFileSync(path, text)
    }
    originals.clear()
  }
  function negative(name: string, rule: string, mutate: () => void) {
    try {
      mutate()
      const findings = checkWeb(R)
      assert(
        findings.some((f) => f.rule === rule),
        `${name}: ${JSON.stringify(findings)}`,
      )
      results.push({ name, rule, result: 'rejected', count: findings.length })
      console.log('PASS rejected', name)
    } finally {
      restore()
    }
  }
  const probe = 'web/src/features/runs/Drift.tsx'
  for (const tag of ['button', 'input', 'select', 'form', 'table', 'dialog', 'h1'])
    negative(`raw ${tag}`, 'ui/primitive', () =>
      set(probe, `export function Drift(){return <${tag} />}`),
    )
  negative('duplicate page-heading owner', 'ui/primitive', () =>
    set('web/src/ui/OtherHeading.tsx', 'export function OtherHeading(){return <h1>Other</h1>}'),
  )
  negative('native select inside UI', 'ui/custom-select', () =>
    set('web/src/ui/NativeSelect.tsx', 'export function NativeSelect(){return <select/>}'),
  )
  negative('imperative style injection', 'react/dom', () =>
    set(probe, 'export function Drift(){document.body.style.color="red";return null}'),
  )
  negative('literal percentage spacing', 'styles/size', () =>
    append('web/src/styles/components/content.css', '.drift{padding:12%}'),
  )
  negative('inline literal style', 'styles/inline', () =>
    set(probe, `export function Drift(){return <div style={{color:'red'}}/>}`),
  )
  negative('inline style via variable', 'styles/inline', () =>
    set(probe, `const value={color:'red'};export function Drift(){return <div style={value}/>}`),
  )
  negative('spread hides overrides', 'ui/spread', () =>
    set(
      probe,
      `const props={style:{color:'red'}};export function Drift(){return <div {...props}/>}`,
    ),
  )
  negative('per-feature CSS', 'styles/location', () =>
    set('web/src/features/runs/local.css', '.x{padding:12px}'),
  )
  negative('extra CSS entry', 'styles/entry', () =>
    set(probe, `import '../../styles/base.css';export const value=1`),
  )
  negative('missing CSS entry', 'styles/entry', () =>
    set(
      'web/src/main.tsx',
      readFileSync(join(R, 'web/src/main.tsx'), 'utf8').replace("import './styles/index.css'", ''),
    ),
  )
  negative('hex color', 'styles/color', () =>
    append('web/src/styles/components/content.css', '.drift{color:#123456}'),
  )
  negative('named color', 'styles/color', () =>
    append('web/src/styles/components/content.css', '.drift{color:red}'),
  )
  negative('named color in border', 'styles/color', () =>
    append('web/src/styles/components/content.css', '.drift{border:var(--border-width) solid red}'),
  )
  negative('named color in shadow', 'styles/color', () =>
    append('web/src/styles/components/content.css', '.drift{box-shadow:0 0 red}'),
  )
  negative('rgb color', 'styles/color', () =>
    append('web/src/styles/components/content.css', '.drift{color:rgb(1 2 3)}'),
  )
  negative('literal spacing', 'styles/size', () =>
    append('web/src/styles/components/content.css', '.drift{padding:13px}'),
  )
  negative('literal typography', 'styles/type', () =>
    append('web/src/styles/components/content.css', '.drift{font-weight:900}'),
  )
  negative('undefined token', 'styles/undefined-token', () =>
    append('web/src/styles/components/content.css', '.drift{color:var(--not-defined)}'),
  )
  negative('literal fallback', 'styles/tokens', () =>
    append('web/src/styles/components/content.css', '.drift{--local:var(--text,red)}'),
  )
  negative('important override', 'styles/override', () =>
    append('web/src/styles/components/content.css', '.drift{color:var(--text)!important}'),
  )
  negative('oversized heading token', 'styles/compact', () =>
    set(
      'web/src/styles/tokens.css',
      readFileSync(join(R, 'web/src/styles/tokens.css'), 'utf8').replace(
        '--font-page-title-size: 1.5rem',
        '--font-page-title-size: 3rem',
      ),
    ),
  )
  negative('alternate heading owner', 'styles/heading', () =>
    append('web/src/styles/components/content.css', 'h1{font-size:var(--font-page-title-size)}'),
  )
  negative('unknown class', 'styles/class', () =>
    set(probe, 'export function Drift(){return <div className="invented-card"/>}'),
  )
  negative('dynamic feature classes', 'styles/class', () =>
    set(probe, 'export function Drift(){return <div className={"muted"}/>}'),
  )
  negative('custom status appearance', 'ui/feedback', () =>
    set(probe, 'export function Drift(){return <span className="status-passed">OK</span>}'),
  )
  negative('direct network', 'data/client', () => set(probe, "export const value=fetch('/runs')"))
  negative('aliased network', 'data/client', () =>
    set(probe, "const {fetch:send}=globalThis;export const value=send('/runs')"),
  )
  negative('computed network', 'data/client', () =>
    set(probe, "export const value=globalThis['fetch']('/runs')"),
  )
  negative('direct query hook', 'architecture/import', () =>
    set(probe, "import {useQuery as query} from '@tanstack/react-query';export const value=query"),
  )
  negative('direct headless UI', 'architecture/import', () =>
    set(probe, "import {Select} from 'react-aria-components';export {Select}"),
  )
  negative('cross-feature import', 'architecture/import', () =>
    set(probe, "export {DevicesPage} from '../devices/DevicesPage.tsx'"),
  )
  negative('cross-feature dynamic import', 'architecture/import', () =>
    set(probe, "export const value=import('../devices/DevicesPage.tsx')"),
  )
  negative('barrel laundering', 'architecture/import', () =>
    set('web/src/ui/Bridge.ts', "export {DevicesPage} from '../features/devices/DevicesPage.tsx'"),
  )
  negative('alias resolution', 'architecture/import', () => {
    const config = JSON.parse(readFileSync(join(R, 'web/tsconfig.json'), 'utf8'))
    config.compilerOptions.paths = { '@devices/*': ['./src/features/devices/*'] }
    set('web/tsconfig.json', JSON.stringify(config))
    set(probe, "export {DevicesPage} from '@devices/DevicesPage.tsx'")
  })
  negative('cyclic imports', 'architecture/cycle', () => {
    set('web/src/ui/CycleA.ts', "export {b} from './CycleB.ts';export const a=1")
    set('web/src/ui/CycleB.ts', "export {a} from './CycleA.ts';export const b=1")
  })
  negative('DOM mutation', 'react/dom', () =>
    set(probe, "export function Drift(){document.body.innerHTML='hello';return null}"),
  )
  negative('aliased element factory', 'react/dom', () =>
    set(probe, "import {createElement as make} from 'react';export const value=make('button')"),
  )
  negative('render clock', 'react/purity', () =>
    set(probe, 'export function Drift(){return <div>{Date.now()}</div>}'),
  )
  negative('custom hook render clock', 'react/purity', () =>
    set(probe, 'export function useClock(){return Date.now()}'),
  )
  negative('render random in map', 'react/purity', () =>
    set(
      probe,
      'export function Drift(){return [1].map(value=><div key={value}>{Math.random()}</div>)}',
    ),
  )
  negative('HTML styling bypass', 'styles/shell', () =>
    append('web/index.html', '<style>body{color:red}</style>'),
  )
  negative('HTML script bypass', 'architecture/shell', () =>
    append('web/index.html', '<script>document.body.innerHTML="x"</script>'),
  )
  negative('unparseable source', 'architecture/syntax', () => set(probe, 'export const value = {;'))
  // Legitimate patterns must remain accepted, including callbacks that run outside render.
  try {
    set(
      probe,
      "import {Button} from '../../ui/Button.tsx';export function Drift(){return <Button onClick={()=>console.log(Date.now())}>Clock</Button>}",
    )
    assert.deepEqual(checkWeb(R), [])
    results.push({ name: 'event handler clock', result: 'accepted' })
    console.log('PASS event handler clock')
  } finally {
    restore()
  }
  assert.deepEqual(checkWeb(R), [])
  try {
    set(
      probe,
      'export const documentation = "fetch innerHTML #fff 13px" // document.createElement("button")',
    )
    append('web/src/styles/components/content.css', '/* color:#fff; padding:13px */')
    assert.deepEqual(checkWeb(R), [])
    results.push({ name: 'source text and CSS comments', result: 'accepted' })
    console.log('PASS source text and CSS comments')
  } finally {
    restore()
  }
  // Exercise the actual Biome override on a temporary file in this isolated worktree, then remove it.
  const biomeProbe = join(R, probe)
  const biomeConfig = JSON.parse(readFileSync(join(W, 'biome.json'), 'utf8'))
  biomeConfig.vcs.enabled = false
  writeFileSync(join(R, 'biome.json'), JSON.stringify(biomeConfig))
  const checks: readonly [string, string, string][] = [
    [
      'conditional hook',
      "import {useState} from 'react';export function Drift({ready}:{ready:boolean}){if(ready)useState(0);return null}",
      'useHookAtTopLevel',
    ],
    [
      'missing effect dependency',
      "import {useEffect} from 'react';export function Drift({value}:{value:string}){useEffect(()=>{console.log(value)},[]);return null}",
      'useExhaustiveDependencies',
    ],
    [
      'array index key',
      "export function Drift(){return <>{['a'].map((value,index)=><span key={index}>{value}</span>)}</>}",
      'noArrayIndexKey',
    ],
    ['explicit any', 'export function Drift(value:any){return value}', 'noExplicitAny'],
    [
      'nested component',
      'export function Drift(){function Inside(){return <span/>}return <Inside/>}',
      'noNestedComponentDefinitions',
    ],
  ]
  try {
    for (const [name, source, expected] of checks) {
      writeFileSync(biomeProbe, source)
      const r = spawnSync(
        join(W, 'node_modules/.bin/biome'),
        ['lint', 'web/src/features/runs/Drift.tsx'],
        { cwd: R, encoding: 'utf8' },
      )
      const output = r.stdout + r.stderr
      assert(r.status !== 0 && output.includes(expected), `${name}: ${output}`)
      results.push({ name, rule: expected, result: 'rejected by Biome' })
      console.log('PASS Biome', name)
    }
    const cssProbe = join(R, 'web/src/styles/Duplicate.css')
    writeFileSync(cssProbe, ':root { --duplicate: 1px; --duplicate: 1px; }')
    const cssResult = spawnSync(
      join(W, 'node_modules/.bin/biome'),
      ['lint', 'web/src/styles/Duplicate.css'],
      { cwd: R, encoding: 'utf8' },
    )
    assert(
      cssResult.status !== 0 &&
        `${cssResult.stdout}${cssResult.stderr}`.includes('noDuplicateCustomProperties'),
    )
    results.push({ name: 'duplicate CSS token', result: 'rejected by Biome' })
    console.log('PASS Biome duplicate CSS token')
  } finally {
    rmSync(biomeProbe, { force: true })
  }
  console.log('Web policy self-tests passed:', results.length, 'negative/positive cases')
} finally {
  rmSync(R, { recursive: true, force: true })
}

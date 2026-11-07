// Project-specific boundaries that the general React linter cannot know. Read-only; no fixes.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'

export type WebFinding = { file: string; line: number; rule: string; message: string }
const slash = (path: string) => path.split(sep).join('/')
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`source symlink is not allowed: ${path}`)
      return entry.isDirectory() ? walk(path) : [path]
    })
    .sort()
}
function layer(path: string) {
  const parts = path.split('/')
  if (path === 'main.tsx') return 'main'
  if (parts[0] === 'features' && parts.length >= 3) return `feature:${parts[1]}`
  return ['app', 'ui', 'lib', 'styles'].includes(parts[0] ?? '') ? parts[0] : undefined
}

export function checkWeb(project: string): WebFinding[] {
  const root = realpathSync(project),
    source = resolve(root, 'web/src')
  const html = readFileSync(resolve(root, 'web/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const shell = resolve(root, 'web/index.html')
  const files = walk(source),
    findings: WebFinding[] = []
  const nameOf = (path: string) => slash(relative(root, path))
  const report = (file: string, line: number, rule: string, message: string) =>
    findings.push({ file: nameOf(file), line, rule, message })
  if (
    /<style\b|\bstyle\s*=|\bon[a-z]+\s*=/i.test(html) ||
    /<link\b[^>]*rel\s*=\s*['"]?stylesheet/i.test(html)
  )
    report(shell, 1, 'styles/shell', 'HTML shell cannot inject styles or event handlers')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  if (
    scripts.length !== 1 ||
    !scripts[0] ||
    scripts[0][2]?.trim() ||
    !/type=["']module["']/.test(scripts[0][1] ?? '') ||
    !/src=["']\/src\/main\.tsx["']/.test(scripts[0][1] ?? '')
  )
    report(shell, 1, 'architecture/shell', 'HTML loads only the main.tsx module; no inline scripts')
  const configPath = resolve(root, 'web/tsconfig.json')
  // TypeScript 7's native compiler supplies the AST and resolved module symbols.
  const api = new API({ cwd: root })
  let snapshot: ReturnType<API['updateSnapshot']> | undefined
  try {
    snapshot = api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath)
    if (!project) throw new Error('TypeScript did not load web/tsconfig.json')
    const program = project.program
    let cssEntryCount = 0
    const graph = new Map<string, Set<string>>()
    const cssFiles = files.filter((file) => file.endsWith('.css'))
    const styles = resolve(source, 'styles'),
      entry = resolve(styles, 'index.css'),
      tokens = resolve(styles, 'tokens.css')
    const declared = new Set<string>(),
      classes = new Set<string>(),
      references: { file: string; line: number; name: string }[] = []
    const imports = new Map<string, number>()
    const runtimeVariables = new Set(['--trigger-width']) // React Aria's measured popover width.
    for (const file of cssFiles) {
      if (!inside(styles, file))
        report(file, 1, 'styles/location', 'CSS belongs in web/src/styles only')
      const ast = postcss.parse(readFileSync(file, 'utf8'), { from: file })
      ast.walkRules((rule) => {
        for (const match of rule.selector.matchAll(/\.([A-Za-z_][\w-]*)/g))
          classes.add(match[1] ?? '')
        if (/(^|[\s,>+~])h1\b/.test(rule.selector) && file !== resolve(styles, 'base.css'))
          report(
            file,
            rule.source?.start?.line ?? 1,
            'styles/heading',
            'page heading appearance belongs to base.css',
          )
      })
      ast.walkAtRules((rule) => {
        if (rule.name !== 'import') return
        const match = /^['"]([^'"]+)['"]$/.exec(rule.params)
        const target = match?.[1] ? resolve(dirname(file), match[1]) : ''
        if (file !== entry || !target || !inside(styles, target) || !cssFiles.includes(target))
          report(
            file,
            rule.source?.start?.line ?? 1,
            'styles/import',
            'only styles/index.css imports existing local style files',
          )
        else imports.set(target, (imports.get(target) ?? 0) + 1)
      })
      ast.walkDecls((decl) => {
        const line = decl.source?.start?.line ?? 1,
          value = decl.value
        if (decl.prop.startsWith('--')) declared.add(decl.prop)
        for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g))
          references.push({ file, line, name: match[1] ?? '' })
        if (file === tokens) {
          if (!decl.prop.startsWith('--') && decl.prop !== 'color-scheme')
            report(
              file,
              line,
              'styles/tokens',
              'tokens.css contains token declarations, not component styling',
            )
          if (decl.parent?.type !== 'rule' || decl.parent.selector !== ':root')
            report(file, line, 'styles/tokens', 'tokens must be declared on :root')
          if (['--font-page-title-size', '--font-page-title-mobile'].includes(decl.prop)) {
            const size = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value)
            const maximum = decl.prop.endsWith('mobile') ? 22 : 24
            if (!size || Number(size[1]) * (size[2] === 'rem' ? 16 : 1) > maximum)
              report(file, line, 'styles/compact', `page title token must be at most ${maximum}px`)
          }
          return
        }
        // The parser isolates declarations; comments, selectors and media breakpoints are not values.
        if (
          /#(?:[\da-f]{3,8})\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(
            value,
          )
        )
          report(file, line, 'styles/color', 'color literals belong in tokens.css')
        if (
          /(?:^|[^\w-])-?(?:\d*\.)?\d+(?:px|r?em|ch|ex|vh|vw|vmin|vmax|svh|dvh|pt|cm|mm|in)\b/i.test(
            value,
          )
        )
          report(file, line, 'styles/size', 'dimension literals belong in tokens.css; use a token')
        const colorProperty =
          /^(?:color$|background|border|outline|fill$|stroke$|box-shadow$|text-shadow$|caret-color$|accent-color$)/.test(
            decl.prop,
          )
        if (colorProperty) {
          const remaining = value.replace(/var\(\s*--[\w-]+\s*\)/g, '')
          const keywords = new Set([
            'none',
            'transparent',
            'currentColor',
            'inherit',
            'initial',
            'unset',
            'solid',
            'dashed',
            'dotted',
            'double',
            'collapse',
            'separate',
            'inset',
            'calc',
            'min',
            'max',
            'clamp',
            'linear-gradient',
            'radial-gradient',
            'to',
            'left',
            'right',
            'top',
            'bottom',
            'center',
            'cover',
            'contain',
            'auto',
            'repeat',
            'no-repeat',
            'padding-box',
            'border-box',
            'content-box',
          ])
          if ([...remaining.matchAll(/[A-Za-z][\w-]*/g)].some((m) => !keywords.has(m[0])))
            report(
              file,
              line,
              'styles/color',
              'use color tokens, not named colors or literal fallbacks',
            )
        }
        if (decl.prop.startsWith('--') && !/^(?:var|calc)\(/.test(value))
          report(
            file,
            line,
            'styles/tokens',
            'component custom properties may alias tokens, not define new literals',
          )
        if (
          /^(font(?:-.+)?|line-height)$/.test(decl.prop) &&
          !/^(?:var\(|inherit$|normal$)/.test(value)
        )
          report(file, line, 'styles/type', 'typography values belong in tokens.css')
        if (/var\(\s*--[\w-]+\s*,/.test(value))
          report(
            file,
            line,
            'styles/tokens',
            'declare tokens centrally instead of using local literal fallbacks',
          )
        if (
          /^(?:margin|padding|gap|row-gap|column-gap|border-radius)(?:-|$)/.test(decl.prop) &&
          /\d%/.test(value)
        )
          report(file, line, 'styles/size', 'spacing percentages belong in tokens.css')
        if (decl.important)
          report(file, line, 'styles/override', '!important bypasses shared component styling')
      })
    }
    for (const ref of references)
      if (!declared.has(ref.name) && !runtimeVariables.has(ref.name))
        report(ref.file, ref.line, 'styles/undefined-token', `undefined CSS token ${ref.name}`)
    for (const file of cssFiles)
      if (file !== entry && imports.get(file) !== 1)
        report(
          file,
          1,
          'styles/entry',
          'every stylesheet must be imported exactly once by styles/index.css',
        )

    const primitives = new Set([
      'button',
      'input',
      'select',
      'option',
      'form',
      'table',
      'dialog',
      'h1',
    ])
    const network = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon'])
    const domMutation = new Set([
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'createElement',
      'createElementNS',
      'insertRule',
      'replaceSync',
      'adoptedStyleSheets',
    ])
    for (const file of files) {
      const local = slash(relative(source, file)),
        owner = layer(local)
      if (!owner)
        report(
          file,
          1,
          'architecture/location',
          'source belongs in app/, features/<name>/, ui/, lib/, styles/ or main.tsx',
        )
      if (/\.(?:js|jsx|mjs|cjs|scss|sass|less|html)$/.test(file))
        report(
          file,
          1,
          'architecture/source',
          'frontend source is TypeScript; styles are centralized CSS',
        )
      if (!/\.tsx?$/.test(file)) continue
      const tree = program.getSourceFile(file)
      if (!tree) {
        report(file, 1, 'architecture/source', 'source is not included by web/tsconfig.json')
        continue
      }
      if (program.getSyntacticDiagnostics(file).length) {
        report(
          file,
          1,
          'architecture/syntax',
          'TypeScript could not parse this source; fix its syntax before auditing',
        )
        continue
      }
      graph.set(file, new Set())
      const at = (node: ts.Node, rule: string, message: string) =>
        report(
          file,
          tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
          rule,
          message,
        )
      const module = (
        node: ts.Node,
        specifier: string,
        typeOnly = false,
        resolutionNode: ts.Node = node,
      ) => {
        if (specifier.endsWith('.css')) {
          if (local === 'main.tsx' && specifier === './styles/index.css') cssEntryCount++
          if (local !== 'main.tsx' || specifier !== './styles/index.css')
            at(node, 'styles/entry', 'only main.tsx imports ./styles/index.css')
          return
        }
        const symbol = project.checker.getSymbolAtLocation(resolutionNode)
        const target = symbol?.declarations[0]?.resolve()?.getSourceFile().fileName
        if (target && inside(source, target)) {
          graph.get(file)?.add(target)
          const dependency = layer(slash(relative(source, target)))
          const sameFeature = owner?.startsWith('feature:') && owner === dependency
          const allowed =
            owner === 'main'
              ? dependency === 'app'
              : owner === 'app'
                ? dependency !== 'main'
                : owner === 'lib'
                  ? dependency === 'lib'
                  : owner === 'ui'
                    ? dependency === 'ui' || dependency === 'lib'
                    : sameFeature || dependency === 'ui' || dependency === 'lib'
          if (!allowed)
            at(node, 'architecture/import', `${owner} must not import ${dependency}: ${specifier}`)
          return
        }
        const localImport =
          specifier.startsWith('.') || isAbsolute(specifier) || !target?.includes('/node_modules/')
        if (
          specifier === '@nowait/shared' ||
          specifier === 'react' ||
          specifier.startsWith('react/')
        )
          return
        if (specifier === 'react-dom/client' && local === 'main.tsx') return
        if (specifier.startsWith('react-aria-components') && owner === 'ui') return
        if (
          specifier === '@tanstack/react-query' &&
          (local === 'lib/api.ts' || local === 'app/providers.tsx' || typeOnly)
        )
          return
        at(
          node,
          'architecture/import',
          localImport
            ? `unresolved or out-of-boundary import: ${specifier}`
            : `dependency must be accessed through its shared boundary: ${specifier}`,
        )
      }
      function visit(node: ts.Node, inRender = false) {
        let rendering = inRender
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)
        ) {
          const name =
            'name' in node && node.name && ts.isIdentifier(node.name)
              ? node.name.text
              : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
                ? node.parent.name.text
                : ''
          if (
            /^(?:[A-Z]|use[A-Z])/.test(name) ||
            name === 'render' ||
            ts.isExportAssignment(node.parent)
          )
            rendering = true
          else if (
            name ||
            (ts.isCallExpression(node.parent) &&
              !['map', 'flatMap', 'filter', 'some', 'every'].includes(
                ts.isPropertyAccessExpression(node.parent.expression)
                  ? node.parent.expression.name.text
                  : '',
              ))
          )
            rendering = false
          else if (ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent))
            rendering = false
        }
        if (
          rendering &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['Date.now', 'Math.random', 'crypto.randomUUID'].includes(node.expression.getText(tree))
        )
          at(
            node,
            'react/purity',
            'read clocks and random values in effects or event handlers, not render',
          )
        if (
          rendering &&
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'Date'
        )
          at(node, 'react/purity', 'construct dates outside render')
        if (
          ts.isIdentifier(node) &&
          ['createElement', 'createElementNS', 'cloneElement'].includes(node.text) &&
          owner !== 'ui'
        )
          at(node, 'react/dom', 'use JSX and shared primitives, not aliased element factories')
        if (ts.isIdentifier(node) && network.has(node.text) && local !== 'lib/api.ts')
          at(node, 'data/client', 'network identifiers belong to lib/api.ts, including aliases')
        if (
          ts.isElementAccessExpression(node) &&
          node.argumentExpression &&
          ts.isStringLiteral(node.argumentExpression) &&
          network.has(node.argumentExpression.text) &&
          local !== 'lib/api.ts'
        )
          at(node, 'data/client', 'computed network access belongs to lib/api.ts')
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          if (ts.isStringLiteral(node.moduleSpecifier)) {
            const typeOnly = ts.isExportDeclaration(node)
              ? node.isTypeOnly
              : node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
            module(node, node.moduleSpecifier.text, typeOnly, node.moduleSpecifier)
          }
        }
        if (ts.isCallExpression(node)) {
          const call = node.expression
          if (
            call.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(call) && call.text === 'require')
          ) {
            const arg = node.arguments[0]
            if (call.kind !== ts.SyntaxKind.ImportKeyword || !arg || !ts.isStringLiteral(arg))
              at(
                node,
                'architecture/import',
                'use a static import or a literal dynamic import so boundaries can be checked',
              )
            else module(node, arg.text, false, arg)
          }
          const name = ts.isIdentifier(call)
            ? call.text
            : ts.isPropertyAccessExpression(call)
              ? call.name.text
              : undefined
          if (name && network.has(name) && local !== 'lib/api.ts')
            at(node, 'data/client', 'network access belongs to lib/api.ts')
          if (name && domMutation.has(name))
            at(node, 'react/dom', 'React owns DOM creation and mutations; use shared components')
          if (
            ts.isPropertyAccessExpression(call) &&
            call.expression.getText(tree) === 'import.meta' &&
            call.name.text === 'glob'
          )
            at(node, 'architecture/import', 'glob imports hide architectural dependencies')
        }
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          network.has(node.expression.text) &&
          local !== 'lib/api.ts'
        )
          at(node, 'data/client', 'network access belongs to lib/api.ts')
        if (
          ts.isPropertyAccessExpression(node) &&
          ['innerHTML', 'outerHTML', 'adoptedStyleSheets', 'style'].includes(node.name.text)
        )
          at(node, 'react/dom', 'React owns DOM content and styles')
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(tree)
          const primitiveOwner: Record<string, string> = {
            button: 'ui/Button.tsx',
            input: 'ui/Input.tsx',
            form: 'ui/Form.tsx',
            table: 'ui/Table.tsx',
            dialog: 'ui/Dialog.tsx',
            h1: 'ui/Page.tsx',
          }
          if (primitives.has(tag) && local !== primitiveOwner[tag])
            at(node, 'ui/primitive', `use the canonical shared UI component instead of <${tag}>`)
          if (['select', 'option'].includes(tag))
            at(
              node,
              'ui/custom-select',
              'visible selects use ui/Select; only the library may generate hidden native form fields',
            )
          if (['style', 'script'].includes(tag))
            at(node, 'styles/injection', 'scripts and style tags do not belong in JSX')
          for (const attr of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr) && owner !== 'ui')
              at(
                attr,
                'ui/spread',
                'pass explicit props; spreads can hide style and behavior overrides',
              )
            if (!ts.isJsxAttribute(attr)) continue
            const key = attr.name.getText(tree)
            if (key === 'style') {
              const value = attr.initializer
              const object = value && ts.isJsxExpression(value) ? value.expression : undefined
              const valid =
                local === 'ui/TimelineBlock.tsx' &&
                object &&
                ts.isObjectLiteralExpression(object) &&
                object.properties.length === 2 &&
                object.properties.every(
                  (p) =>
                    ts.isPropertyAssignment(p) &&
                    ['left', 'width'].includes(p.name.getText(tree)) &&
                    ts.isTemplateExpression(p.initializer) &&
                    p.initializer.head.text === '' &&
                    p.initializer.templateSpans.length === 1 &&
                    p.initializer.templateSpans[0]?.literal.text === '%',
                )
              if (!valid)
                at(
                  attr,
                  'styles/inline',
                  'only TimelineBlock may set computed left/width percentages inline',
                )
            }
            if (key === 'dangerouslySetInnerHTML')
              at(attr, 'react/dom', 'React must escape content')
            if (
              key === 'role' &&
              owner !== 'ui' &&
              attr.initializer &&
              ts.isStringLiteral(attr.initializer) &&
              ['button', 'combobox', 'listbox', 'option', 'dialog', 'menu'].includes(
                attr.initializer.text,
              )
            )
              at(attr, 'ui/primitive', 'interactive roles belong to shared UI primitives')
            if (
              key === 'className' &&
              owner?.startsWith('feature:') &&
              attr.initializer &&
              !ts.isStringLiteral(attr.initializer)
            )
              at(
                attr,
                'styles/class',
                'feature classes are literal names from centralized styles; variants belong to shared UI',
              )
            if (key === 'className' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
              for (const name of attr.initializer.text.split(/\s+/).filter(Boolean)) {
                if (!classes.has(name))
                  at(attr, 'styles/class', `class ${name} is not declared in centralized styles`)
                if (
                  owner?.startsWith('feature:') &&
                  /^(?:status(?:-|$)|count(?:s|$)|error$)/.test(name)
                )
                  at(attr, 'ui/feedback', 'status, counts and errors use the shared UI components')
              }
            }
          }
        }
        node.forEachChild((child) => visit(child, rendering))
      }
      visit(tree)
    }
    if (cssEntryCount !== 1)
      report(
        resolve(source, 'main.tsx'),
        1,
        'styles/entry',
        'main.tsx must import styles/index.css exactly once',
      )
    const visiting = new Set<string>(),
      visited = new Set<string>()
    function cycle(file: string) {
      if (visiting.has(file)) {
        report(file, 1, 'architecture/cycle', 'circular imports make component ownership unclear')
        return
      }
      if (visited.has(file)) return
      visiting.add(file)
      for (const dependency of graph.get(file) ?? []) cycle(dependency)
      visiting.delete(file)
      visited.add(file)
    }
    for (const file of graph.keys()) cycle(file)
    return findings.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
    )
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const findings = checkWeb(project)
  for (const f of findings) console.error(`${f.file}:${f.line} [${f.rule}] ${f.message}`)
  if (findings.length) process.exitCode = 1
  else console.log('Web architecture and style checks passed')
}

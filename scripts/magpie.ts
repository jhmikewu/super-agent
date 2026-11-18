#!/usr/bin/env node
/**
 * Connects dsh-superagent to a local magpie gateway (`magpie web`, default http://localhost:3425) and picks the
 * orchestrator and worker models among the models it serves.
 *
 *   node scripts/magpie.ts sync  [--profile superagent] [--magpie <url>] [--default <model>] [--key-env <NAME>]
 *   node scripts/magpie.ts list  [--magpie <url>]
 *   node scripts/magpie.ts roles [--profile superagent] [--url <panel>] [--orchestrator <model>|inherit] [--worker <model>|inherit]
 *
 * `sync` reads magpie's `/v1/models` and writes `<DSH_HOME>/profiles/<profile>/magpie.patch.yml`, a patch overlay that
 * `scripts/dsh-superagent start` passes to DSH. It gives `@deepseek-ai/dsh-llm-pi-ai` one route per wire protocol, so each
 * model family speaks its native API through magpie, and sets DSH's default model, which roles left on "inherit" and DSH's
 * own helpers (compaction, titles) use. The profile's `cordis.patch.yml` is left alone because DSH's settings pages rewrite it.
 *
 * `roles` reads and saves the Eval (orchestrator) and Executor (worker) model blocks through the Management API of a
 * running service, at the profile's webserver address unless `--url` names one. A `<model>` is `[<provider>:]<model id>[@<effort>]`; without a provider, the route serving that id is used.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

/** One entry of magpie's OpenAI-style `/v1/models` list, as far as this script reads it. */
export interface MagpieModel {
  id: string
  owned_by?: string
  display_name?: string
  magpie_label?: string
  context_window?: number
  context_length?: number
  max_input_tokens?: number
  max_output_tokens?: number
  modalities?: { input?: string[] }
  reasoning?: boolean
  reasoning_levels?: string[]
}
/** A `models` entry of a `@deepseek-ai/dsh-llm-pi-ai` provider route. */
export interface RouteModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  input: string[]
  reasoningEfforts: Record<string, string> | false
}
export interface Route {
  displayName: string
  api: 'anthropic-messages' | 'openai-responses' | 'openai-completions'
  baseURL: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models: RouteModel[]
}
export interface Selection { provider: string; model: string; reasoningEffort?: string }

/** The route each model family takes: Claude over Anthropic Messages, OpenAI/Codex over Responses, anything else over Chat Completions. */
const FAMILIES = [
  { route: 'magpie-claude', displayName: 'Magpie · Claude', api: 'anthropic-messages', match: ['claude', 'anthropic'] },
  { route: 'magpie-codex', displayName: 'Magpie · Codex', api: 'openai-responses', match: ['codex', 'openai'] },
  { route: 'magpie', displayName: 'Magpie', api: 'openai-completions', match: [] },
] as const
/** pi-ai's thinking levels; magpie's `none` is its `off`. A level outside this list, such as `ultra`, is not offered. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODALITIES = ['text', 'image']
/** Preferred DSH default when none is given or the saved one is gone, first match wins. */
const PREFERRED_DEFAULT = [/^claude\/claude-sonnet/, /sonnet/, /^claude\//]

export function familyOf(model: MagpieModel): typeof FAMILIES[number] {
  const owner = (model.owned_by ?? '').toLowerCase(), prefix = model.id.split('/', 1)[0]!.toLowerCase()
  return FAMILIES.find(family => (family.match as readonly string[]).some(name => owner === name || prefix === name)) ?? FAMILIES[2]
}

const positive = (...values: (number | undefined)[]) => values.find(value => Number.isInteger(value) && value! > 0)

export function routeModel(model: MagpieModel): RouteModel {
  const efforts: Record<string, string> = {}
  for (const wire of model.reasoning_levels ?? []) {
    const level = wire === 'none' ? 'off' : wire
    if (LEVELS.includes(level)) efforts[level] = wire
  }
  const input = (model.modalities?.input ?? ['text']).filter(kind => MODALITIES.includes(kind))
  const contextWindow = positive(model.context_window, model.context_length, model.max_input_tokens)
  const maxTokens = positive(model.max_output_tokens)
  return {
    id: model.id,
    name: model.magpie_label ?? model.display_name ?? model.id,
    ...contextWindow ? { contextWindow } : {},
    ...maxTokens ? { maxTokens } : {},
    input: input.includes('text') ? input : ['text', ...input],
    // pi-ai refuses an effort list that offers nothing beyond `off`; such a model is declared non-reasoning.
    reasoningEfforts: Object.keys(efforts).some(level => level !== 'off') ? efforts : false,
  }
}

/** Builds the pi-ai provider routes for everything magpie serves at `base`; a family with no models gets no route. */
export function routesFrom(models: MagpieModel[], base: string, keyEnv?: string): Record<string, Route> {
  const root = base.replace(/\/+$/, '').replace(/\/v1$/, '')
  const routes: Record<string, Route> = {}
  for (const model of models) {
    const family = familyOf(model)
    const anthropic = family.api === 'anthropic-messages'
    // magpie takes any key; a placeholder header satisfies clients that insist on one, unless a real key is named.
    const headers: Record<string, string> = anthropic ? { 'x-api-key': 'magpie' } : { authorization: 'Bearer magpie' }
    const auth = keyEnv ? { apiKeyEnv: keyEnv } : { headers }
    const route = routes[family.route] ??= { displayName: family.displayName, api: family.api,
      baseURL: anthropic ? root : `${root}/v1`, ...auth, models: [] }
    route.models.push(routeModel(model))
  }
  return routes
}

/** Parses `[<provider>:]<model id>[@<effort>]`, taking the provider from `routes` when it is left out. */
export function parseSpec(spec: string, routes: Record<string, { models: { id: string }[] }>): Selection {
  const at = spec.lastIndexOf('@')
  const [head, reasoningEffort] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined]
  const colon = head.indexOf(':')
  let provider = colon > 0 ? head.slice(0, colon) : '', model = colon > 0 ? head.slice(colon + 1) : head
  if (!provider) {
    const serving = Object.entries(routes).filter(([, route]) => route.models.some(entry => entry.id === model)).map(([id]) => id)
    if (serving.length === 0) throw new Error(`No route serves "${model}". Run \`node scripts/magpie.ts list\` to see the models.`)
    if (serving.length > 1) throw new Error(`"${model}" is served by ${serving.join(', ')}; name one as <provider>:${model}.`)
    provider = serving[0]!
  }
  if (!model) throw new Error(`"${spec}" names no model.`)
  return { provider, model, ...reasoningEffort ? { reasoningEffort } : {} }
}

/** Keeps `previous` while a route still serves it, otherwise the first preferred model, otherwise the first model at all. */
export function chooseDefault(routes: Record<string, Route>, previous?: Selection): Selection | undefined {
  const all = Object.entries(routes).flatMap(([provider, route]) => route.models.map(model => ({ provider, model })))
  if (previous && all.some(({ provider, model }) => provider === previous.provider && model.id === previous.model)) return previous
  for (const pattern of PREFERRED_DEFAULT) {
    const found = all.find(({ model }) => pattern.test(model.id))
    if (found) return { provider: found.provider, model: found.model.id }
  }
  return all[0] && { provider: all[0].provider, model: all[0].model.id }
}

const HEADER = '# Generated by `node scripts/magpie.ts sync`; re-run it when magpie\'s models change, then restart dsh-superagent.\n'
  + '# DSH reads this overlay after the profile layer: `scripts/dsh-superagent start` passes it with --patch.\n'
/** The overlay: YAML that is also JSON (after its comment lines), so it reads back without a YAML parser. */
export function overlay(source: string, routes: Record<string, Route>, selection: Selection | undefined): string {
  const entries: unknown[] = [{ id: 'llm-pi-ai', config: { providers: routes } }]
  if (selection) entries.push({ id: 'agent-default-model', config: selection })
  return `${HEADER}# Source: ${source}\n${JSON.stringify(entries, null, 2)}\n`
}
export function readOverlay(text: string): { routes: Record<string, Route>; selection?: Selection } {
  const entries = JSON.parse(text.replace(/^#.*$/gm, '')) as { id: string; config: any }[]
  const selection = entries.find(entry => entry.id === 'agent-default-model')?.config as Selection | undefined
  return { routes: entries.find(entry => entry.id === 'llm-pi-ai')?.config.providers ?? {}, ...selection ? { selection } : {} }
}

export const overlayPath = (profile: string, home = process.env.DSH_HOME || join(homedir(), '.dsh')) =>
  join(home, 'profiles', profile, 'magpie.patch.yml')

/** The panel URL from the `webserver` entry of a profile's cordis.patch.yml text, else http://127.0.0.1:3082. */
export function profileUrl(patch: string): string {
  const entry = /^- id: webserver\n((?:[ \t].*\n?|\n)*)/m.exec(patch)?.[1] ?? ''
  const host = /^\s+host:\s*['"]?([^\s'"#]+)/m.exec(entry)?.[1] ?? '127.0.0.1'
  const port = /^\s+port:\s*(\d+)/m.exec(entry)?.[1] ?? '3082'
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}
function readProfileUrl(profile: string): string {
  try { return profileUrl(readFileSync(join(dirname(overlayPath(profile)), 'cordis.patch.yml'), 'utf8')) }
  catch { return profileUrl('') }
}

async function fetchModels(base: string): Promise<MagpieModel[]> {
  const url = `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`
  let response: Response
  try { response = await fetch(url, { signal: AbortSignal.timeout(10_000) }) }
  catch (error) { throw new Error(`magpie does not answer at ${url}: ${(error as Error).message}. Is \`magpie web\` running?`) }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const models = ((await response.json()) as { data?: MagpieModel[] }).data ?? []
  if (models.length === 0) throw new Error(`magpie at ${url} serves no models; add a provider in magpie first.`)
  return models
}

/** Calls the Management API of a running dsh-superagent. */
async function api<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${base.replace(/\/+$/, '')}/orchestrator/api/${path}`
  let response: Response
  try {
    response = await fetch(url, { method, headers: { 'x-orchestrator-request': '1', ...body ? { 'content-type': 'application/json' } : {} },
      ...body ? { body: JSON.stringify(body) } : {}, signal: AbortSignal.timeout(30_000) })
  } catch (error) { throw new Error(`dsh-superagent does not answer at ${base}: ${(error as Error).message}. Start it with scripts/dsh-superagent start.`) }
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

const show = (selection: Selection | null | undefined, fallback?: Selection): string => selection
  ? `${selection.provider}:${selection.model}${selection.reasoningEffort ? `@${selection.reasoningEffort}` : ''}`
  : `inherit${fallback ? ` (DSH default ${show(fallback)})` : ''}`

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: {
    profile: { type: 'string', default: process.env.DSH_SUPERAGENT_PROFILE || 'superagent' },
    magpie: { type: 'string', default: process.env.MAGPIE_URL || 'http://localhost:3425' },
    url: { type: 'string', default: process.env.DSH_SUPERAGENT_URL },
    default: { type: 'string' }, 'key-env': { type: 'string' }, orchestrator: { type: 'string' }, worker: { type: 'string' },
  } })
  if (command === 'list') {
    const routes = routesFrom(await fetchModels(values.magpie), values.magpie)
    for (const [provider, route] of Object.entries(routes)) {
      console.log(`${provider}  (${route.api})`)
      for (const model of route.models) {
        const efforts = model.reasoningEfforts ? Object.keys(model.reasoningEfforts).join(' ') : 'no reasoning'
        console.log(`  ${model.id.padEnd(30)} ${model.name}  [${efforts}]`)
      }
    }
  } else if (command === 'sync') {
    const routes = routesFrom(await fetchModels(values.magpie), values.magpie, values['key-env'])
    const path = overlayPath(values.profile)
    let previous: Selection | undefined
    try { previous = readOverlay(readFileSync(path, 'utf8')).selection } catch {}
    const selection = values.default ? parseSpec(values.default, routes) : chooseDefault(routes, previous)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, overlay(values.magpie, routes, selection), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    const count = Object.values(routes).reduce((sum, route) => sum + route.models.length, 0)
    console.log(`Wrote ${path}: ${count} models on ${Object.keys(routes).join(', ')}; DSH default ${show(selection)}.`)
    console.log('Restart dsh-superagent to load them: scripts/dsh-superagent restart')
  } else if (command === 'roles') {
    type Block = { value: { model: Selection | null } & Record<string, unknown>; revision: number }
    type Catalog = { default?: Selection; groups: { id: string; models: { id: string }[] }[] }
    const url = values.url ?? readProfileUrl(values.profile)
    const [settings, catalog] = await Promise.all([api<{ blocks: Record<'eval' | 'executor', Block> }>(url, 'GET', 'settings'),
      api<Catalog>(url, 'GET', 'models')])
    const routes = Object.fromEntries(catalog.groups.map(group => [group.id, group]))
    for (const [flag, block] of [['orchestrator', 'eval'], ['worker', 'executor']] as const) {
      const spec = values[flag]
      if (spec === undefined) continue
      const model = spec === 'inherit' ? null : parseSpec(spec, routes)
      const { value, revision } = settings.blocks[block]
      await api(url, 'PUT', `settings/${block}`, { value: { ...value, model }, revision })
      settings.blocks[block].value.model = model
    }
    console.log(`orchestrator  ${show(settings.blocks.eval.value.model, catalog.default)}`)
    console.log(`worker        ${show(settings.blocks.executor.value.model, catalog.default)}`)
    if (values.orchestrator !== undefined || values.worker !== undefined)
      console.log('New Sessions use these; a running main Session or Executor keeps the model it started with.')
  } else {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)![1]!.replace(/^ \* ?/gm, '').trim())
    if (command && command !== 'help' && command !== '--help') process.exitCode = 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

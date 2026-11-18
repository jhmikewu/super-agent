// The magpie gateway routes: which protocol each model family takes, and how a model is named on the command line.
import { describe, expect, it } from 'vitest'
import { chooseDefault, overlay, overlayPath, parseSpec, profileUrl, readOverlay, routesFrom, type MagpieModel } from '../scripts/magpie.ts'

const claude: MagpieModel = { id: 'claude/claude-sonnet-5-5', owned_by: 'claude', display_name: 'Claude Sonnet 5.5',
  magpie_label: 'Claude Sonnet 5.5 · Claude Code', context_window: 1_000_000, max_output_tokens: 128_000,
  modalities: { input: ['text', 'image', 'pdf'] }, reasoning: true, reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'] }
const group: MagpieModel = { ...claude, id: 'auto/claude-opus-5-5', magpie_label: 'Claude Opus 5.5 · routing group' }
const codex: MagpieModel = { id: 'codex/gpt-6.2-sol', owned_by: 'codex', display_name: 'GPT-6.2-Sol', context_window: 500_000,
  max_output_tokens: 128_000, modalities: { input: ['text', 'image'] }, reasoning_levels: ['low', 'high', 'max', 'ultra'] }
const deepseek: MagpieModel = { id: 'deepseek/deepseek-flash', owned_by: 'deepseek', display_name: 'DeepSeek-V4.1-Flash',
  context_length: 1_048_576, max_output_tokens: 393_216, reasoning_levels: ['none', 'low', 'high', 'max'] }
const plain: MagpieModel = { id: 'local/tiny', reasoning_levels: ['none'] }

describe('routesFrom', () => {
  const routes = routesFrom([claude, group, codex, deepseek, plain], 'http://localhost:3425/v1/')
  it('sends each family over its native protocol, with Anthropic at the API root and OpenAI-style routes under /v1', () => {
    expect(Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, [route.api, route.baseURL, route.models.map(m => m.id)]])))
      .toEqual({
        'magpie-claude': ['anthropic-messages', 'http://localhost:3425', ['claude/claude-sonnet-5-5', 'auto/claude-opus-5-5']],
        'magpie-codex': ['openai-responses', 'http://localhost:3425/v1', ['codex/gpt-6.2-sol']],
        magpie: ['openai-completions', 'http://localhost:3425/v1', ['deepseek/deepseek-flash', 'local/tiny']],
      })
  })
  it('keeps the gateway\'s sizes, image input and reasoning levels, mapping `none` to `off` and leaving out levels pi-ai lacks', () => {
    expect(routes['magpie-claude']!.models[0]).toEqual({ id: 'claude/claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · Claude Code',
      contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } })
    expect(routes['magpie-codex']!.models[0]!.reasoningEfforts).toEqual({ low: 'low', high: 'high', max: 'max' })
    expect(routes.magpie!.models[0]).toMatchObject({ contextWindow: 1_048_576, input: ['text'],
      reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } })
    // A model that offers nothing beyond `off` is declared non-reasoning, which pi-ai requires.
    expect(routes.magpie!.models[1]).toEqual({ id: 'local/tiny', name: 'local/tiny', input: ['text'], reasoningEfforts: false })
  })
  it('authenticates with a placeholder magpie accepts, or with a named credential when one is given', () => {
    expect(routes['magpie-claude']!.headers).toEqual({ 'x-api-key': 'magpie' })
    expect(routes['magpie-codex']!.headers).toEqual({ authorization: 'Bearer magpie' })
    const keyed = routesFrom([claude], 'http://localhost:3425', 'MAGPIE_API_KEY')['magpie-claude']!
    expect([keyed.apiKeyEnv, keyed.headers]).toEqual(['MAGPIE_API_KEY', undefined])
  })
})

describe('parseSpec', () => {
  const routes = routesFrom([claude, codex, deepseek], 'http://localhost:3425')
  it('finds the route serving a bare model id, and reads an effort after @', () => {
    expect(parseSpec('claude/claude-sonnet-5-5@high', routes)).toEqual({ provider: 'magpie-claude', model: 'claude/claude-sonnet-5-5',
      reasoningEffort: 'high' })
    expect(parseSpec('magpie-codex:codex/gpt-6.2-sol', routes)).toEqual({ provider: 'magpie-codex', model: 'codex/gpt-6.2-sol' })
  })
  it('refuses a model no route serves, or one several serve without a provider', () => {
    expect(() => parseSpec('nope/model', routes)).toThrow('No route serves "nope/model"')
    const both = { a: { models: [{ id: 'm' }] }, b: { models: [{ id: 'm' }] } }
    expect(() => parseSpec('m', both)).toThrow('served by a, b')
    expect(parseSpec('b:m', both)).toEqual({ provider: 'b', model: 'm' })
  })
})

describe('chooseDefault and the overlay', () => {
  const routes = routesFrom([codex, group, claude, deepseek], 'http://localhost:3425')
  it('keeps a default the gateway still serves, and otherwise prefers a direct Sonnet', () => {
    const kept = { provider: 'magpie-codex', model: 'codex/gpt-6.2-sol', reasoningEffort: 'high' }
    expect(chooseDefault(routes, kept)).toBe(kept)
    expect(chooseDefault(routes, { provider: 'magpie', model: 'gone' })).toEqual({ provider: 'magpie-claude', model: 'claude/claude-sonnet-5-5' })
    expect(chooseDefault(routesFrom([deepseek], 'http://x'))).toEqual({ provider: 'magpie', model: 'deepseek/deepseek-flash' })
    expect(chooseDefault({})).toBeUndefined()
  })
  it('writes YAML that reads back as the same routes and default', () => {
    const selection = { provider: 'magpie-claude', model: 'auto/claude-opus-5-5' }
    const text = overlay('http://localhost:3425', routes, selection)
    expect(text.startsWith('# Generated by')).toBe(true)
    expect(readOverlay(text)).toEqual({ routes, selection })
  })
  it('lives beside the profile\'s own patch', () => {
    expect(overlayPath('superagent', '/home/me/.dsh')).toBe('/home/me/.dsh/profiles/superagent/magpie.patch.yml')
  })
})

describe('profileUrl', () => {
  it('reads the panel address from the profile\'s webserver entry, and falls back to loopback', () => {
    const patch = "# comment\n- id: webserver\n  config:\n    host: 100.122.222.74\n    port: 3090\n- id: dsh-superagent\n  config:\n    stateDir: /x\n"
    expect(profileUrl(patch)).toBe('http://100.122.222.74:3090')
    expect(profileUrl("- id: webserver\n  config:\n    host: '::1'\n")).toBe('http://[::1]:3082')
    expect(profileUrl('- id: dsh-superagent\n  config:\n    host: 10.0.0.1\n')).toBe('http://127.0.0.1:3082')
    expect(profileUrl('')).toBe('http://127.0.0.1:3082')
  })
})

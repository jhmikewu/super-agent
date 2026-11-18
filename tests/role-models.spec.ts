import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel, switchRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, flush, request, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

it('moves a resumed Session that last used another model to the role model from its next request, without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  record({ provider: 'old', model: 'one' })
  expect(await switchRoleModel(ctx, agent, { provider: 'orchestrator', model: 'two', reasoningEffort: 'high' })).toBe(true)
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'model/selection', data: { provider: 'orchestrator', model: 'two',
    reasoningEffort: 'high' } })
  expect(flush).toHaveBeenCalledOnce()
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'orchestrator', model: 'two' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'orchestrator', model: 'two', reasoningEffort: 'high' })
  record(selected)
  // Once a request on the new model is logged, the Session goes on from that request's route.
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('leaves a Session already on the role model, and a role on inherit, as they are', async () => {
  const { ctx, agent, record, resolve } = await fixture()
  record({ provider: 'orchestrator', model: 'two', reasoningEffort: ReasoningEffortId('low') })
  const before = agent.session.snapshotEvents().length
  // Without a configured effort, the effort in use is no reason to switch; a different configured effort is.
  expect(await switchRoleModel(ctx, agent, { provider: 'orchestrator', model: 'two' })).toBe(false)
  expect(await switchRoleModel(ctx, agent, null)).toBe(false)
  expect(agent.session.snapshotEvents()).toHaveLength(before)
  expect(resolve).toHaveBeenCalledOnce()
  expect(await switchRoleModel(ctx, agent, { provider: 'orchestrator', model: 'two', reasoningEffort: 'high' })).toBe(true)
})
it('lets the newest switch win when the role model changes twice before the next request', async () => {
  const { ctx, agent, request, record } = await fixture()
  record({ provider: 'old', model: 'one' })
  await switchRoleModel(ctx, agent, { provider: 'orchestrator', model: 'two' })
  await switchRoleModel(ctx, agent, { provider: 'orchestrator', model: 'three' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual({ provider: 'orchestrator', model: 'three' })
  // A pending selection that already names the role model needs no new one.
  expect(await switchRoleModel(ctx, agent, { provider: 'orchestrator', model: 'three' })).toBe(false)
})

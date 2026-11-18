/** Resolves per-role models and puts a Session on its role's model without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  selectNext(ctx, agent, await resolveRoleModel(ctx, model))
  await ctx.sessionPersistence.flush()
}

/**
 * Put a Session, new or resumed, on its role's configured model from its next request, when that request would use another
 * route; a selection made by hand in DSH is replaced. Inherit (`null`) leaves the Session's model as it is.
 * @returns whether the Session was moved to another model.
 */
export async function switchRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<boolean> {
  if (!model) return false
  const selected = await resolveRoleModel(ctx, model)
  const next = nextSelection(agent)
  // Without a configured effort, the effort the Session uses now (often the adapter's default) is not a reason to switch.
  if (next && next.provider === selected.provider && next.model === selected.model
    && (!model.reasoningEffort || next.reasoningEffort === selected.reasoningEffort)) return false
  selectNext(ctx, agent, selected)
  await ctx.sessionPersistence.flush()
  return true
}

/** The route a Session's next request takes on its own: a selection logged after its last request, else that request's route. */
function nextSelection(agent: Agent): ModelSelection | undefined {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'model/selection') return event.data as ModelSelection
    if (event.type === 'request/header') return agent.session.requestHeader()?.config
  }
  return undefined
}

/** The override each live Agent currently carries, so a newer selection replaces it instead of stacking on it. */
const overrides = new WeakMap<Agent, () => void>()
/**
 * Log `selected` durably, which a resumed Session reads as its pending selection, and apply it to this process's next request.
 * DSH's `selectModel` would do both but also saves the global default, so the request is redirected here until a request is
 * logged, after which the Session continues on the route that request used.
 */
function selectNext(ctx: Context, agent: Agent, selected: ModelSelection): void {
  overrides.get(agent)?.()
  agent.session.append('model/selection', selected)
  let pending = true
  let assembled: ModelSelection | undefined
  const dispose = agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = pending ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) pending = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  overrides.set(agent, () => { pending = false; assembled = undefined; dispose() })
}

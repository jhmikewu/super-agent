# 009 Models

This document covers which models dsh-superagent runs on and how to choose them. It builds on [003 Execution](003-execution.md) and [006 Deployment](006-deployment.md).

## Two roles, two models

dsh-superagent runs two kinds of DeepSeek Harness Session, and each has its own model setting:

| Role | Session | Setting | Panel |
| --- | --- | --- | --- |
| **Orchestrator** | The one main Session: it assesses Triggers, opens Tickets, routes follow-ups and supervises workers | `eval.model` | Settings → Eval → Orchestrator model |
| **Worker** | One Executor Session per Ticket, which does the work, and the subagents it spawns, which inherit its model | `executor.model` | Settings → Execution → Worker model |

Each setting is a provider route, a model id and an optional reasoning effort, or **Inherit**, which uses DeepSeek Harness's default model. The panel offers what `GET models` lists, grouped by provider, and the efforts the chosen model supports. **Other…** takes a provider and model by hand for an id the catalog does not list. A save is refused when the route does not resolve.

The two roles weigh cost differently. The orchestrator reads every request and stays running across all Tickets, so it benefits from a strong model at a moderate effort. Workers do the bulk of the token-heavy coding, and several run at once, up to `maxWorkers`.

### When a change applies

- **Orchestrator:** the main Session switches from its next step, and again when it resumes after a restart if it is on another model. A model picked by hand in DeepSeek Harness's own Session view is replaced the same way. With Inherit, the main Session keeps the model it has.
- **Worker:** new Executor Sessions use it. A running Ticket keeps the model it started with, because switching models halfway through a change costs more than it saves. A retry reuses the Ticket's Session and so its model; to move the work, stop the Ticket and ask again, which opens a new one.

DeepSeek Harness's own helpers, such as compaction summaries and Session titles, use its default model.

## The local magpie gateway

In this fork the models come from magpie, a local model gateway, running as `magpie web` on `http://localhost:3425`. magpie serves an OpenAI-style `/v1/models` list and speaks the Anthropic Messages, OpenAI Responses and OpenAI Chat Completions protocols for every model it routes. It accepts any API key.

`scripts/magpie.ts` connects it to DeepSeek Harness's `@deepseek-ai/dsh-llm-pi-ai` adapter, which every DeepSeek Harness profile mounts with no routes:

```sh
node scripts/magpie.ts list                           # what magpie serves, by route
node scripts/magpie.ts sync                           # write the routes and DSH's default model
node scripts/magpie.ts sync --default auto/claude-sonnet-5-5@medium
scripts/dsh-superagent restart                        # routes load at startup
node scripts/magpie.ts roles                          # show both role models
node scripts/magpie.ts roles --orchestrator claude/claude-opus-5-5@high --worker codex/gpt-6.2-sol@medium
node scripts/magpie.ts roles --worker inherit
```

`sync` gives each model family the protocol it speaks natively, as its own provider route:

| Route | Protocol | Models |
| --- | --- | --- |
| `magpie-claude` | Anthropic Messages, at `http://localhost:3425` | `owned_by` or id prefix `claude` / `anthropic` |
| `magpie-codex` | OpenAI Responses, at `http://localhost:3425/v1` | `codex` / `openai` |
| `magpie` | OpenAI Chat Completions, at `http://localhost:3425/v1` | everything else, such as DeepSeek |

Each model keeps magpie's context window, output limit, image input and reasoning levels. magpie's `none` level is offered as `off`; a level DeepSeek Harness does not know, such as `ultra`, is left out.

`sync` writes `<DSH_HOME>/profiles/<profile>/magpie.patch.yml`, a patch overlay that `scripts/dsh-superagent start` passes to DeepSeek Harness with `--patch`. It is generated: run `sync` again when magpie's models change, then restart. The profile's own `cordis.patch.yml` is not touched, because DeepSeek Harness's settings pages rewrite it. The overlay also sets DeepSeek Harness's default model. `sync` keeps the default it set before while magpie still serves it; otherwise it picks Claude Sonnet, or `--default` names one.

A `<model>` on the command line is `[<provider>:]<model id>[@<effort>]`. Without a provider, `roles` uses the route that serves the id. `roles` talks to the running service's Management API (`--url`, default `http://127.0.0.1:3082`); `sync` and `list` talk to magpie (`--magpie`, or `MAGPIE_URL`).

magpie takes any key, so the routes send a placeholder. If your magpie requires caller keys, `sync --key-env MAGPIE_API_KEY` makes each route read its key from that credential reference instead: DeepSeek Harness resolves it from `$DSH_HOME/.credentials.yaml` or the environment.

### Other providers

The same adapter routes to any provider directly, for example OpenAI, Anthropic, OpenRouter or a vLLM server. Add its routes to the profile's `cordis.patch.yml` under `- id: llm-pi-ai`, or through DeepSeek Harness's Models page. The role settings accept any registered route; see the `@deepseek-ai/dsh-llm-pi-ai` README for the fields.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `magpie does not answer at …` | Start magpie with `magpie web`, or pass `--magpie <url>` |
| The model lists are empty, or show only DeepSeek | No overlay was loaded: run `node scripts/magpie.ts sync`, then `scripts/dsh-superagent restart` |
| A save says `The eval model is not available: …` | The route or model id is not registered: check `node scripts/magpie.ts list`, and sync again if magpie changed |
| A model is missing after magpie added it | Run `sync` again and restart |

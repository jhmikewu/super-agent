# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## This fork: local models through magpie

This copy of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) runs on the models a local magpie gateway serves (Claude, GPT/Codex, DeepSeek, …), and lets you choose the **orchestrator** (main Session) and the **workers** (one Executor Session per Ticket) independently.

Prerequisites: Node.js 22.19+ or 24, pnpm, tmux, git, a running `magpie web` (default `http://localhost:3425`), and the DSH CLI. First run only, from this checkout:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3 --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null    # creates ~/.dsh/profiles/superagent
dsh plugin --profile superagent add "link:$PWD"
cp examples/profile.cordis.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml   # then set stateDir in it
```

Then:

```sh
node scripts/magpie.ts sync                      # magpie's models → DSH routes in the superagent profile
scripts/dsh-superagent start
node scripts/magpie.ts roles --orchestrator claude/claude-opus-5-5@high --worker codex/gpt-6.2-sol@medium
```

Or pick both in the panel: **Settings → Eval → Orchestrator model** and **Settings → Execution → Worker model**. [docs/009-models.md](docs/009-models.md) explains the routes, the defaults and when a change applies.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Models](docs/009-models.md): the orchestrator and worker models, and the local magpie gateway

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

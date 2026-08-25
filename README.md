# agent-pr-review

A steerable Eve engineering agent with an evidence-gated pull-request reviewer at its core. It uses direct Anthropic BYOK (`claude-fable-5` by default), durable Eve sessions, Vercel Sandbox, Vercel Connect-backed GitHub and Slack channels, CI lifecycle primitives, scoped long-term-memory contracts, and approval-gated draft PR creation.

## Capability Status

- Automated repository-locked review and safe inline publication: implemented.
- GitHub `@mention` conversations through Vercel Connect: implemented; connector provisioning required.
- Slack mentions, DMs, threaded continuation, and interactive approvals through Vercel Connect: implemented for conversation and user-scoped memory. Repository tools require a deployment-provisioned verified Slack-to-GitHub identity link; an in-agent linking flow is not yet implemented.
- CI terminal-event continuation and task-state primitives: implemented. Full required-check discovery, settling windows, durable deadlines, and automatic deferral of the legacy webhook are the next orchestration increment.
- User, repository, and PR memory schemas, PostgreSQL adapter, retrieval, confirmed writes, provenance, and author-controlled forgetting: implemented. Apply `db/schema.sql` before enabling memory. Organization memory remains schema-only until verified organization membership and Slack-to-GitHub identity linking are wired; Slack receives only its user-scoped memory.
- Generic approval-gated draft PR creation for any connector-authorized repository, including this repository: implemented for complete file replacements. Sandbox-generated patch capture and automatic test-evidence attachment remain to be wired.

Fable 5 is used at standard inference speed. Anthropic's literal `speed: "fast"` mode does not currently support Fable 5; do not enable that provider option until Anthropic adds support.

## Architecture

1. `POST /webhook` verifies `X-Hub-Signature-256` against the exact raw body before parsing JSON.
2. The channel accepts only `pull_request` actions `opened`, `synchronize`, `reopened`, and `ready_for_review`; it rejects other repositories, drafts, and bot-authored events.
3. A signed payload becomes immutable Eve authentication attributes: owner, repository, PR number, base/head SHA and refs, installation/delivery IDs, fork status, and execution policy. Tools derive all scope from those attributes.
4. The durable continuation token includes owner/repository/PR/head SHA. A retry resumes the same pass; every push creates a new pass.
5. A hidden per-PR marker locates one bot-authored issue comment. Head and delivery markers form a lightweight claim: exact-head redeliveries return as duplicates when the run is reviewing or complete, while concurrent creates converge on the oldest bot comment. Every update/delete re-reads the comment, verifies bot ownership and expected head state, then rechecks the PR head immediately before mutation.
6. Eve's session-persistent sandbox lets the reviewer clone the exact head, inspect the full repository and Git history, install dependencies, and run focused checks. Fork code is analysis-only by default. A read-only GitHub credential, when configured, is brokered by the Eve/Vercel firewall into requests to `github.com`; it never enters sandbox process environment.
7. Completion text is parsed into a strict Zod-validated JSON contract. `changed_files` is compared with complete pagination; PRs above GitHub's 3,000-file files-API cap or short pagination fail closed. Immediately before publication, files and the PR head are fetched again; stale, off-diff, duplicate, and over-limit findings are dropped.
8. Publication uses GitHub itself as the distributed lock. The agent creates or recovers a bot-authored exact-head `PENDING` review containing the final summary and draft inline comments, elects the lowest matching review ID, deletes losing pending reviews, rechecks the head, and submits only that pending review as `COMMENT`. A lost create/submit response is reconciled by listing marked pending/submitted reviews. If the post-submit head check detects a newer push, the agent deletes every inline comment from that review and rewrites its body to a hidden-marker-bearing “superseded; findings withdrawn” notice. Compensation is idempotent and resumes after partial or lost responses.

The review policy is deliberately deeper than a one-shot diff prompt: risk-map intake, caller/contract exploration, deterministic checks, candidate generation, adversarial falsification, a coverage-gap pass, at most two refinement iterations, then high-confidence synthesis. Style and nit comments are excluded.

## Setup

Requirements: Node 24 and pnpm.

```bash
cp .env.example .env
pnpm install
pnpm verify
pnpm dev
```

No runtime secret is needed to install, typecheck, test, or build. Runtime requires:

- `ANTHROPIC_API_KEY`: direct Anthropic API key. `ANTHROPIC_MODEL` defaults to `claude-fable-5`; no AI gateway or OpenAI-compatible proxy is used.
- `GITHUB_WEBHOOK_SECRET`: high-entropy webhook secret.
- `GITHUB_TOKEN`: host-only GitHub credential used to read PR data and write comments/reviews.
- `GITHUB_SANDBOX_TOKEN`: optional separate read-only credential retained by the host and brokered by the sandbox firewall only into HTTPS requests to `github.com`.
- `GITHUB_CONNECTOR`: Vercel Connect GitHub connector UID, default `github/eve`.
- `SLACK_CONNECTOR`: Vercel Connect Slack connector UID, default `slack/eve`.
- `AGENT_BOT_NAME`: GitHub mention name created by the connector, default `eve`.
- `DATABASE_URL`: PostgreSQL connection used for long-term memory and durable orchestration state.

If `GITHUB_SANDBOX_TOKEN` is absent, scoped host tools provide the tree and file contents safely. That supports static review but not arbitrary Git commands or test execution. Set it for the intended full workflow.

Provision and attach the Connect triggers to the native Eve channel routes:

```bash
vercel connect create github --name eve --triggers
vercel connect attach github/eve --triggers --trigger-path /eve/v1/github
vercel connect create slack --name eve --triggers
vercel connect attach slack/eve --triggers --trigger-path /eve/v1/slack
```

The existing signed `/webhook` endpoint remains available during migration for automatic PR review. Connect-backed mentions use `/eve/v1/github`; Slack uses `/eve/v1/slack`.

Apply the durable-state schema to the configured database before using memory:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

## GitHub Configuration

For v1, a fine-grained PAT is sufficient. Restrict it to `NicolaiSchmid/nunc-immo` with:

- Contents: read
- Pull requests: read and write
- Issues: read and write
- Metadata: read
- Administration: read (used only to verify the authenticated caller's repository role before repository tools run)

The sandbox token should be a different fine-grained token restricted to the same repository with only Contents: read. Never reuse the host token there. Neither GitHub token is included in sandbox environment options: Eve's network policy injects the read-only authorization header at the firewall, and the host mutation token is never brokered.

Configure a GitHub webhook:

- URL: `https://<deployment>/webhook`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Event: Pull requests
- Actions handled: opened, synchronize, reopened, ready for review

A GitHub App is the production recommendation because installation-scoped, short-lived tokens reduce PAT blast radius. Give the App the same repository permissions, including Administration: read for caller authorization, and subscribe only to pull request events. The current typed client is intentionally token-based v1; swapping token acquisition does not change scope or publication logic.

## Deploy

Deploy as a normal Eve application on Vercel and set the runtime environment variables there. Eve selects Vercel Sandbox in deployment. Its egress policy permits only GitHub/GitHubusercontent plus npm and pnpm registry hosts required to install and test `nunc-immo`; local Docker fallback is deny-all.

```bash
pnpm verify
pnpm build
```

Set `ALLOW_FORK_EXECUTION=true` only after explicitly accepting that untrusted fork code and lifecycle scripts will execute in the isolated sandbox. The default is static analysis only. Even when enabled, use a read-only sandbox token.

## Security Properties

- Repository identity is hard-coded and checked case-insensitively.
- HMAC uses SHA-256 over raw bytes and a timing-safe comparison.
- PR metadata in model prompts cannot override authenticated scope.
- All host tools obtain owner/repo/PR/ref from the Eve session, not tool input.
- Mutation and sandbox credentials are separated; neither token enters sandbox process environment, and the model never receives the host token.
- Only comments/reviews authored by the `/user` identity of the configured host token count as state; participant marker spoofing is ignored.
- Same-head reviewing/completed state prevents redeliveries from starting a new Eve turn.
- Review publication checks the current head before pending creation, immediately before pending submission, and after submission; it validates every line against the freshly fetched patch.
- A stale submitted review is compensated: its actionable inline comments are deleted and its body is replaced with a superseded/withdrawn notice. Superseded reviews never count as completed and are not reposted on retry.
- Existing marked pending reviews are resumed, and submitted reviews reconcile the stable progress comment to completed after lost responses or webhook retries.
- Pull-file pagination must equal GitHub's `changed_files`; reviews above the 3,000-file API cap are rejected rather than run with partial context.
- GitHub API pagination has a hard safety bound and errors include status/context but never credentials.
- Prompt injection in repository content is explicitly treated as untrusted data.

Residual v1 limitations: GitHub may omit `patch` for very large/binary files, so inline findings on those files are conservatively dropped; PRs with more than 3,000 changed files cannot be reviewed through this API and fail clearly; no external database or queue is used beyond Eve durability and GitHub state; a GitHub App token provider is not yet implemented; and fork execution is a coarse deployment-wide opt-in. GitHub serializes pending reviews per user, which makes publication idempotent. Submission and a concurrent push remain separate external mutations, but the post-submit check now compensates that race by withdrawing the submitted review’s actionable content. During the brief interval before compensation completes, GitHub may momentarily display stale comments; retries resume cleanup until none remain.

## Why This Design

Many capable review products and open-source agents already exist. The design borrows specific, inspectable ideas rather than pretending a one-shot prompt is novel:

- [PR-Agent](https://github.com/qodo-ai/pr-agent) demonstrates configurable PR tooling, repository context, compression, and self-reflection.
- [Mumpys/ai-review](https://github.com/Mumpys/ai-review) documents an iterative ReAct-style agent mode that explores a repository with shell and Git before reviewing.
- [PR-AF](https://github.com/Agent-Field/pr-af) makes evidence grounding, falsification gates, adaptive review dimensions, and coverage-depth loops explicit.
- [Greptile](https://www.greptile.com/) describes graph-indexed repository context and a swarm of reviewers; [TREX](https://www.greptile.com/trex.md) extends review into sandboxed test generation/execution.
- [CodeRabbit's review overview](https://docs.coderabbit.ai/guides/code-review-overview) documents repository-wide context, code-graph analysis, static tooling, incremental updates, and inline review UX.

GitHub's primary API documentation drives publication details: [create a pull request review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request), [review comments and modern line/side parameters](https://docs.github.com/en/rest/pulls/comments), and [webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

The research conclusion is not that another general-purpose reviewer is needed. This bespoke version is justified by the exact combination required here: BYOK Fable through direct Anthropic, Eve durable per-head sessions, Vercel Sandbox, a fixed-repository trust boundary, update-in-place progress, and an evidence-gated deep loop with deterministic publication controls.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

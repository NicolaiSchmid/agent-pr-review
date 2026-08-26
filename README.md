# agent-pr-review

A compact, repository-locked Eve agent that reviews pull requests for `NicolaiSchmid/nunc-immo`. It uses direct Anthropic BYOK (`claude-fable-5` by default), durable Eve sessions, Vercel Sandbox, one update-in-place progress comment, evidence-gated inline findings, and bounded stacked fix pull requests.

## Architecture

1. `POST /webhook` verifies `X-Hub-Signature-256` against the exact raw body before parsing JSON.
2. The channel accepts only `pull_request` actions `opened`, `synchronize`, `reopened`, and `ready_for_review`; it rejects other repositories, drafts, and bot-authored events.
3. A signed payload becomes immutable Eve authentication attributes: owner, repository, PR number, base/head SHA and refs, installation/delivery IDs, fork status, and execution policy. Tools derive all scope from those attributes.
4. The durable continuation token includes owner/repository/PR/head SHA. A retry resumes the same pass; every push creates a new pass.
5. A hidden per-PR marker locates one bot-authored issue comment. Head and delivery markers form a lightweight claim: exact-head redeliveries return as duplicates when the run is reviewing or complete, while concurrent creates converge on the oldest bot comment. Every update/delete re-reads the comment, verifies bot ownership and expected head state, then rechecks the PR head immediately before mutation.
6. Eve's session-persistent sandbox lets the reviewer clone the exact head, inspect the full repository and Git history, install dependencies, and run focused checks. Fork code is analysis-only by default. A read-only GitHub credential, when configured, is brokered by the Eve/Vercel firewall into requests to `github.com`; it never enters sandbox process environment.
7. Completion text is parsed into a strict Zod-validated JSON contract; in-flight version-1 sessions are normalized to version 2 with no stacked changes during rollout. `changed_files` is compared with complete pagination; PRs above GitHub's 3,000-file files-API cap or short pagination fail closed. Immediately before publication, files and the PR head are fetched again; stale, off-diff, duplicate, and over-limit findings are dropped.
8. Publication uses GitHub itself as the distributed lock. The agent creates or recovers a bot-authored exact-head `PENDING` review containing the final summary and draft inline comments, elects the lowest matching review ID, deletes losing pending reviews, rechecks the head, and submits only that pending review as `COMMENT`. A lost create/submit response is reconciled by listing marked pending/submitted reviews. If the post-submit head check detects a newer push, the agent deletes every inline comment from that review and rewrites its body to a hidden-marker-bearing “superseded; findings withdrawn” notice. Compensation is idempotent and resumes after partial or lost responses.
9. When validated findings have tested fixes that fit the model output budget, the completion contract includes bounded whole-file replacements. The host revalidates their finding locations against the current diff, preserves existing Git file modes, creates Git blobs/tree/commit on a deterministic `eve/review-<root>-round-<n>-<sha>` branch, and opens a PR targeting the branch just reviewed. Hidden root/round/parent metadata makes the next generated PR another review input and produces `main ← original PR ← round 1 ← round 2`. Empty fixes, forks, stale heads, invalid findings, no-op trees, unsupported Git entry types, and rounds beyond `MAX_REVIEW_ROUNDS` do not create a PR. Head changes around external mutations trigger branch/PR compensation, and existing branches and PRs are recovered on retry.

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

If `GITHUB_SANDBOX_TOKEN` is absent, scoped host tools provide the tree and file contents safely. That supports static review but not arbitrary Git commands or test execution. Set it for the intended full workflow.

## GitHub Configuration

For v1, a fine-grained PAT is sufficient. Restrict it to `NicolaiSchmid/nunc-immo` with:

- Contents: read and write (required to create stacked fix commits and branches)
- Pull requests: read and write
- Issues: read and write
- Metadata: read

The sandbox token should be a different fine-grained token restricted to the same repository with only Contents: read. Never reuse the host token there. Neither GitHub token is included in sandbox environment options: Eve's network policy injects the read-only authorization header at the firewall, and the host mutation token is never brokered. `GITHUB_BOT_LOGIN` is required before stacked mutation and must match the authenticated App/PAT login so bot-authored stacked PR webhooks can be recognized without admitting unrelated bot PRs. If it is absent, the primary review still publishes but no dead-end fix PR is created. `MAX_REVIEW_ROUNDS` defaults to `3`; `MAX_REVIEW_CHANGE_BYTES` defaults to `20000` so escaped fix payloads leave ample room in the final response budget. Both stack limits are validated as positive safe integers at startup.

Configure a GitHub webhook:

- URL: `https://<deployment>/webhook`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Event: Pull requests
- Actions handled: opened, synchronize, reopened, ready for review

A GitHub App is the production recommendation because installation-scoped, short-lived tokens reduce PAT blast radius. Give the App the same repository permissions and subscribe only to pull request events. The current typed client is intentionally token-based v1; swapping token acquisition does not change scope or publication logic.

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
- Stacked mutations accept at most 20 files and 20 KB per round, require an exact path match between replacements and freshly validated inline findings, reject non-blob replacements, preserve source modes, and use the reviewed SHA as the sole parent and base tree.

Residual v1 limitations: GitHub may omit `patch` for very large/binary files, so inline findings on those files are conservatively dropped; PRs with more than 3,000 changed files cannot be reviewed through this API and fail clearly; no external database or queue is used beyond Eve durability and GitHub state; a GitHub App token provider is not yet implemented; fork fixes cannot form the same safe same-repository stack and remain review-only; and fork execution is a coarse deployment-wide opt-in. Whole-file replacements intentionally do not support deletions, renames, symlinks, or submodules. GitHub serializes pending reviews per user, which makes publication idempotent. Submission and a concurrent push remain separate external mutations, but the post-submit check now compensates that race by withdrawing the submitted review’s actionable content. During the brief interval before compensation completes, GitHub may momentarily display stale comments; retries resume cleanup until none remain.

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

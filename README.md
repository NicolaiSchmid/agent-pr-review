# agent-pr-review

A planned Eve agent for deep, evidence-based pull request reviews on [`NicolaiSchmid/nunc-immo`](https://github.com/NicolaiSchmid/nunc-immo).

## Goal

The agent should:

- run automatically when a pull request is opened or receives a new push;
- create one progress comment and update it in place when the review finishes;
- leave precise line-by-line review comments;
- inspect the full repository, not only the diff;
- use a bounded, in-depth review loop to verify findings and reduce false positives;
- run relevant tests, linting, and type checks in an isolated Vercel Sandbox;
- use Eve for durable orchestration;
- call Anthropic directly with `claude-fable-5` using a separately supplied API key.

The implementation will take architectural cues from [`apex-cc/agent-support-triage`](https://github.com/apex-cc/agent-support-triage), adapted from support-ticket triage to GitHub pull-request events.

## Intended review loop

1. Map the diff and identify high-risk areas.
2. Explore callers, contracts, and related code across the repository.
3. Run deterministic checks and relevant tests in the sandbox.
4. Generate candidate findings.
5. Try to falsify each finding with exact code evidence or reproduction.
6. Check for coverage gaps and repeat once when needed.
7. Publish only high-confidence, actionable findings.

## Status

Research and implementation are pending. Runtime credentials, including the Anthropic API key and GitHub integration credentials, will be configured later.

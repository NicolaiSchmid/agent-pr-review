import { defineChannel, POST } from "eve/channels";
import { GitHubClient, IncompletePullFilesError } from "../lib/github.js";
import { extractCompletedAssistantText } from "../lib/message-text.js";
import { publishReview, reconcileExistingReview } from "../lib/publish.js";
import {
  beginProgress,
  reconcileCompletedProgress,
  renderProgress,
  updateProgress,
} from "../lib/progress.js";
import { parseReviewResult } from "../lib/result.js";
import {
  compensateStackedReviewPull,
  createStackedReviewPull,
  verifyStackMutationIdentity,
} from "../lib/stacked-pr.js";
import {
  continuationTokenFor,
  parseSessionFailedRecovery,
  scopeFromContext,
  type ReviewScope,
} from "../lib/scope.js";
import { env, requireEnv } from "../lib/env.js";
import {
  evaluatePullRequestEvent,
  verifyWebhookSignature,
} from "../lib/webhook.js";

const conciseError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

const dispatchClaims = new Set<string>();

const failProgress = async (scope: ReviewScope, error: unknown) => {
  try {
    await updateProgress(
      new GitHubClient(),
      scope,
      renderProgress(scope, "failed", { error: conciseError(error) }),
    );
  } catch (progressError) {
    console.error("failed to update PR review failure status", {
      scope: `${scope.owner}/${scope.repo}#${scope.number}@${scope.headSha}`,
      error: conciseError(progressError),
    });
  }
};

export default defineChannel({
  routes: [
    POST("/webhook", async (request, { send }) => {
      const rawBody = new Uint8Array(await request.arrayBuffer());
      if (
        !verifyWebhookSignature(
          rawBody,
          request.headers.get("x-hub-signature-256"),
          env.githubWebhookSecret,
        )
      ) {
        return Response.json({ accepted: false, reason: "invalid_signature" }, { status: 401 });
      }
      if (request.headers.get("x-github-event") !== "pull_request") {
        return Response.json({ accepted: false, reason: "event_ignored" }, { status: 202 });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        return Response.json({ accepted: false, reason: "malformed_json" }, { status: 400 });
      }
      const decision = evaluatePullRequestEvent(
        payload,
        request.headers.get("x-github-delivery"),
      );
      if (!decision.accepted) {
        const status = decision.reason === "bot_login_required"
          ? 503
          : decision.reason.startsWith("malformed") || decision.reason.startsWith("missing")
            ? 400
            : 202;
        return Response.json(decision, { status });
      }

      const { scope } = decision;
      const dispatchKey = continuationTokenFor(scope);
      if (dispatchClaims.has(dispatchKey)) {
        return Response.json({
          accepted: true,
          duplicate: true,
          reason: "already_reviewing",
          pullRequest: scope.number,
          headSha: scope.headSha,
        });
      }
      dispatchClaims.add(dispatchKey);
      try {
        const client = new GitHubClient();
        const recovered = await reconcileExistingReview(client, scope);
        if (recovered.status === "published") {
          await reconcileCompletedProgress(client, scope, recovered.counts);
          return Response.json({
            accepted: true,
            duplicate: true,
            reason: "already_published",
            pullRequest: scope.number,
            headSha: scope.headSha,
          });
        }
        if (recovered.status !== "none") {
          return Response.json(
            { accepted: false, reason: recovered.status },
            { status: 202 },
          );
        }

        const progress = await beginProgress(client, scope);
        if (!progress.started) {
          return Response.json({
            accepted: true,
            duplicate: true,
            reason: progress.reason,
            pullRequest: scope.number,
            headSha: scope.headSha,
          });
        }
        const pull = await client.getPull(scope);
        if (pull.changed_files > 3_000) {
          throw new IncompletePullFilesError(pull.changed_files);
        }
        await client.listPullFiles(scope, pull.changed_files);
        const prompt = [
          `Review the trusted pull request ${scope.owner}/${scope.repo}#${scope.number}.`,
          `Base SHA: ${scope.baseSha}`,
          `Head SHA: ${scope.headSha}`,
          `Sandbox execution allowed: ${scope.allowExecution}`,
          "Follow the complete deep-review workflow in the system instructions.",
          "Finish with only the required JSON result object.",
        ].join("\n");
        const session = await send(prompt, {
          auth: {
            authenticator: "github-webhook",
            principalType: "service",
            principalId: "github-webhook",
            attributes: { ...scope, number: String(scope.number) },
          },
          continuationToken: continuationTokenFor(scope),
          title: decision.title,
        });
        return Response.json({
          accepted: true,
          sessionId: session.id,
          pullRequest: scope.number,
          headSha: scope.headSha,
        });
      } catch (error) {
        await failProgress(scope, error);
        return Response.json(
          {
            accepted: false,
            reason:
              error instanceof IncompletePullFilesError
                ? "incomplete_pull_files"
                : "review_start_failed",
            error: conciseError(error),
          },
          { status: error instanceof IncompletePullFilesError ? 422 : 502 },
        );
      } finally {
        dispatchClaims.delete(dispatchKey);
      }
    }),
  ],
  events: {
    async "message.completed"(data, _channel, ctx) {
      const text = extractCompletedAssistantText({
        type: "message.completed",
        data,
      });
      if (!text.includes("\"version\"") || !text.includes("\"findings\"")) return;
      const scope = scopeFromContext(ctx);
      try {
        const result = parseReviewResult(text);
        const client = new GitHubClient();
        let stacked: Awaited<ReturnType<typeof createStackedReviewPull>> | {
          status: "skipped";
          reason: "stack_failed";
        } = {
          status: "skipped",
          reason: "stack_failed",
        };
        try {
          const configuredLogin = requireEnv("githubBotLogin").toLowerCase();
          await verifyStackMutationIdentity(client, configuredLogin);
          stacked = await createStackedReviewPull(client, scope, result);
        } catch (stackError) {
          console.error("stacked review PR creation failed; publishing review without fixes", {
            scope: `${scope.owner}/${scope.repo}#${scope.number}@${scope.headSha}`,
            error: conciseError(stackError),
          });
        }
        let publication: Awaited<ReturnType<typeof publishReview>>;
        try {
          publication = await publishReview(client, scope, result);
        } catch (publicationError) {
          if (stacked.status === "created" || stacked.status === "existing") {
            await compensateStackedReviewPull(client, scope, stacked);
          }
          throw publicationError;
        }
        if (
          !publication.published &&
          ["stale", "stale_head", "stale_after_submit", "superseded"].includes(
            publication.reason,
          )
        ) {
          if (stacked.status === "created" || stacked.status === "existing") {
            await compensateStackedReviewPull(client, scope, stacked);
          }
          return;
        }
        if (!("counts" in publication)) {
          throw new Error(`Review publication did not complete: ${publication.reason}`);
        }
        await updateProgress(
          new GitHubClient(),
          scope,
          renderProgress(scope, "completed", {
            summary:
              stacked.status === "created" || stacked.status === "existing"
                ? `${result.summary}\n\nSuggested changes: ${stacked.pull.html_url}`
                : result.summary,
            tests: result.tests.map((test) => `${test.result}: ${test.command}`),
            findings: publication.counts,
          }),
        );
      } catch (error) {
        await failProgress(scope, error);
      }
    },
    async "turn.failed"(event, _channel, ctx) {
      await failProgress(scopeFromContext(ctx), event);
    },
    async "session.failed"(event, channel) {
      const recovery = parseSessionFailedRecovery(
        { type: "session.failed", data: event },
        channel.continuationToken,
      );
      if (!recovery) return;
      await failProgress(
        {
          ...recovery.scope,
          baseSha: recovery.scope.headSha,
          baseRef: "unknown",
          headRef: "unknown",
          deliveryId: "unknown",
          fork: "false",
          allowExecution: "false",
        },
        recovery.failure,
      );
    },
  },
});

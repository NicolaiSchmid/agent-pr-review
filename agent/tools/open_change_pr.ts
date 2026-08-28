import { createHash, randomUUID } from "node:crypto";
import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { store } from "../lib/database.js";
import { env } from "../lib/env.js";
import { requireRepositoryPermission } from "../lib/repository-authorization.js";

const githubAuth = connect({
  connector: env.githubConnector,
  principalType: "app",
});

const isValidBranch = (branch: string) => {
  if (
    branch.endsWith("/") || branch.endsWith(".") || branch.includes("..") ||
    branch.includes("@{") || branch.includes("//") || branch === "@"
  ) return false;
  return branch.split("/").every((component) =>
    component.length > 0 && !component.startsWith(".") &&
    !component.endsWith(".lock") &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(component),
  );
};

const inputSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  baseBranch: z.string().min(1).max(200).optional(),
  branch: z.string().regex(/^eve\/[A-Za-z0-9._/-]{1,180}$/),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(60_000),
  commitMessage: z.string().min(1).max(256),
  files: z.array(z.object({
    path: z.string().min(1).max(1_000),
    content: z.string().max(200_000),
  })).min(1).max(20),
});

export default defineTool({
  description:
    "Create a draft pull request containing complete file replacements in any repository accessible to the configured GitHub connector. Always requires human approval and never merges or deploys.",
  inputSchema,
  approval: always(),
  async execute(input, ctx) {
    if (!isValidBranch(input.branch)) throw new Error("Branch is not a valid Git ref name");
    if (new Set(input.files.map((file) => file.path)).size !== input.files.length) {
      throw new Error("Duplicate file paths are not allowed");
    }
    if (input.files.some((file) => file.path.startsWith("/") || file.path.split("/").includes(".."))) {
      throw new Error("File paths must stay within the repository");
    }
    if (input.files.some((file) =>
      file.path.split("/").some((component) =>
        component === "" || component === "." || /[\u0000-\u001f\u007f]/.test(component),
      ),
    )) {
      throw new Error("File paths must contain only non-empty Git tree components");
    }

    const { token } = await ctx.getToken(githubAuth);
    await requireRepositoryPermission(ctx, token, input.owner, input.repo, "write");
    const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    class GitHubRequestError extends Error {
      constructor(readonly status: number, message: string) {
        super(message);
      }
    }
    class CommitMismatchError extends Error {}
    class CreatedPullInvariantError extends Error {}
    const request = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, cancellable = true) => {
      const response = await fetch(`${env.githubApiUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "eve-engineering-agent",
          "x-github-api-version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(cancellable ? { signal: ctx.abortSignal } : {}),
      });
      if (!response.ok) {
        if (response.status === 401) ctx.requireAuth(githubAuth);
        throw new GitHubRequestError(
          response.status,
          `GitHub ${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    };

    const branchPathFor = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");
    type ListedPull = {
      number: number;
      html_url: string;
      head: { sha: string };
      draft: boolean;
      title: string;
      body: string | null;
    };
    const listPulls = async (baseBranch?: string, cancellable = true) => {
      const pulls: ListedPull[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await request<ListedPull[]>(
          "GET",
          `${root}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${activeBranch}`)}${baseBranch ? `&base=${encodeURIComponent(baseBranch)}` : ""}&per_page=100&page=${page}`,
          undefined,
          cancellable,
        );
        pulls.push(...batch);
        if (batch.length < 100) return pulls;
      }
    };
    const existingPull = async (baseBranch?: string) => (await listPulls(baseBranch))[0];
    const createPull = async (baseBranch: string, commitSha: string) => {
      let createdPullNumber: number | undefined;
      try {
        const pull = await request<{ number: number; html_url: string }>("POST", `${root}/pulls`, {
          title: input.title,
          body: operationBody,
          head: activeBranch,
          base: baseBranch,
          draft: true,
        });
        createdPullNumber = pull.number;
        try {
          await claimOperationPull(pull.number);
        } catch (error) {
          let binding: number | null;
          try {
            const reconciled = await store.getOperation<{ pull_request_number: number | null } | null>(operation.id);
            binding = reconciled?.pull_request_number ?? null;
          } catch {
            throw error;
          }
          if (binding === pull.number) {
            operation.pull_request_number = pull.number;
          } else if (binding === null) {
            try {
              await claimOperationPull(pull.number);
            } catch {
              await request("PATCH", `${root}/pulls/${pull.number}`, { state: "closed" }, false);
              throw error;
            }
          } else {
            await request("PATCH", `${root}/pulls/${pull.number}`, { state: "closed" }, false);
            throw error;
          }
        }
        const created = await request<{
          number: number;
          html_url: string;
          head: { sha: string };
          draft: boolean;
          title: string;
          body: string | null;
          state: string;
          base: { ref: string };
        }>("GET", `${root}/pulls/${pull.number}`);
        if (created.state !== "open") {
          throw new CreatedPullInvariantError("The created pull request is no longer open");
        }
        if (!created.draft) throw new CreatedPullInvariantError("The created pull request is no longer a draft");
        if (created.base.ref !== baseBranch) {
          throw new CreatedPullInvariantError("The created pull request no longer targets the approved base");
        }
        if (created.title !== input.title || (created.body ?? "") !== operationBody) {
          throw new CreatedPullInvariantError("The created pull request metadata no longer matches the approved request");
        }
        await assertMatchingCommit(created.head.sha, await liveBaseSha());
        const validated = await revalidateRecoveredPull(pull.number, created.head.sha);
        return { ...validated, commitSha: validated.head.sha };
      } catch (error) {
        if (createdPullNumber) {
          const created = await request<{ head: { sha: string }; state: string }>(
            "GET", `${root}/pulls/${createdPullNumber}`, undefined, false,
          );
          if (created.state === "open" &&
            (error instanceof CreatedPullInvariantError || error instanceof CommitMismatchError)) {
            if (error instanceof CommitMismatchError &&
              !await store.markRetryableClosure(operation.id, createdPullNumber)) {
              throw new Error("Could not fence stale-base pull request cleanup");
            }
            await request("PATCH", `${root}/pulls/${createdPullNumber}`, { state: "closed" }, false);
            if (error instanceof CommitMismatchError) {
              await releaseOperationPull(createdPullNumber);
            }
          }
          throw error;
        }
        const recoveryPulls = await listPulls(undefined, false);
        const recovered = recoveryPulls.find((candidate) =>
          (candidate.body ?? "") === operationBody
        ) ?? recoveryPulls[0];
        if (recovered) {
          if (!recovered.draft) {
            throw new Error("Refusing to recover a pull request that is no longer a draft");
          }
          if (recovered.title !== input.title || (recovered.body ?? "") !== operationBody) {
            if (operation.pull_request_number === recovered.number) {
              await request("PATCH", `${root}/pulls/${recovered.number}`, { state: "closed" }, false);
            }
            throw new Error("Refusing to recover a pull request with different title or body");
          }
          await claimOperationPull(recovered.number);
          let validatedRecovered;
          try {
            await assertMatchingCommit(recovered.head.sha, await liveBaseSha());
            validatedRecovered = await revalidateRecoveredPull(recovered.number, recovered.head.sha);
          } catch (validationError) {
            if ((validationError instanceof CommitMismatchError ||
              validationError instanceof CreatedPullInvariantError) && operationOwnsPull(recovered)) {
              if (validationError instanceof CommitMismatchError &&
                !await store.markRetryableClosure(operation.id, recovered.number)) {
                throw new Error("Could not fence stale-base pull request cleanup");
              }
              await request("PATCH", `${root}/pulls/${recovered.number}`, { state: "closed" }, false);
              if (validationError instanceof CommitMismatchError) {
                await releaseOperationPull(recovered.number);
              }
            }
            throw validationError;
          }
          return {
            number: validatedRecovered.number,
            html_url: validatedRecovered.html_url,
            commitSha: validatedRecovered.head.sha,
            draft: validatedRecovered.draft,
          };
        }
        throw error;
      }
    };

    const repository = await request<{ default_branch: string }>("GET", root);
    const baseBranch = input.baseBranch ?? repository.default_branch;
    const baseRef = await request<{ object: { sha: string } }>(
      "GET",
      `${root}/git/ref/heads/${baseBranch.split("/").map(encodeURIComponent).join("/")}`,
    );
    const canonicalFiles = [...input.files].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    const operationFingerprint = createHash("sha256").update(JSON.stringify({
      owner: input.owner.toLowerCase(),
      repo: input.repo.toLowerCase(),
      baseBranch,
      branch: input.branch,
      title: input.title,
      body: input.body,
      commitMessage: input.commitMessage,
      files: canonicalFiles,
    })).digest("hex");
    const operation = await store.getOrCreateOperation<{
      id: string; branch: string; pull_request_number: number | null; retryable_closure: boolean;
    }>({
      externalId: randomUUID(), requestFingerprint: operationFingerprint,
      repositoryOwner: input.owner.toLowerCase(), repositoryName: input.repo.toLowerCase(),
      branch: input.branch,
    });
    let activeBranch = operation.branch;
    const operationBody = `${input.body}\n\n<!-- eve-change-operation:${operation.id} -->`;
    const operationOwnsPull = (pull: { number: number; body: string | null }) =>
      (pull.body ?? "") === operationBody &&
      (operation.pull_request_number === null || operation.pull_request_number === pull.number);
    const claimOperationPull = async (number: number) => {
      const claimed = await store.claimOperationPull(operation.id, number);
      if (!claimed) throw new Error("Change operation is already bound to another pull request");
      operation.pull_request_number = number;
      operation.retryable_closure = false;
    };
    const releaseOperationPull = async (number: number) => {
      if (!await store.releaseOperationPull(operation.id, number)) {
        throw new Error("Change operation binding changed before retry cleanup completed");
      }
      operation.pull_request_number = null;
      operation.retryable_closure = false;
    };
    const fingerprintFor = (baseSha: string) => createHash("sha256").update(JSON.stringify({
      owner: input.owner.toLowerCase(),
      repo: input.repo.toLowerCase(),
      baseBranch,
      baseSha,
      branch: input.branch,
      title: input.title,
      body: input.body,
      commitMessage: input.commitMessage,
      files: canonicalFiles,
    })).digest("hex");
    const commitMessageFor = (baseSha: string) =>
      `${input.commitMessage}\n\nEve-Change-Fingerprint: ${fingerprintFor(baseSha)}`;
    const liveBaseSha = async () => (await request<{ object: { sha: string } }>(
      "GET",
      `${root}/git/ref/heads/${baseBranch.split("/").map(encodeURIComponent).join("/")}`,
    )).object.sha;
    const buildExpectedTree = async (baseSha: string) => {
      const baseCommit = await request<{ tree: { sha: string } }>(
        "GET", `${root}/git/commits/${baseSha}`,
      );
      const baseTree = await request<{
        truncated: boolean;
        tree: Array<{ path: string; mode: string; type: string }>;
      }>("GET", `${root}/git/trees/${baseCommit.tree.sha}?recursive=1`);
      if (baseTree.truncated) {
        throw new Error("GitHub returned a truncated base tree; refusing to guess file modes");
      }
      const entries = new Map(baseTree.tree.map((entry) => [entry.path, entry]));
      for (const file of input.files) {
        const existing = entries.get(file.path);
        if (existing && existing.type !== "blob") {
          throw new Error(`Replacement path ${file.path} is an existing ${existing.type}`);
        }
        const segments = file.path.split("/");
        for (let index = 1; index < segments.length; index += 1) {
          const ancestor = entries.get(segments.slice(0, index).join("/"));
          if (ancestor && ancestor.type !== "tree") {
            throw new Error(`Replacement path ${file.path} descends from an existing ${ancestor.type}`);
          }
        }
        if (input.files.some(
          (candidate) => candidate.path !== file.path &&
            (candidate.path.startsWith(`${file.path}/`) || file.path.startsWith(`${candidate.path}/`)),
        )) {
          throw new Error("Replacement paths cannot be ancestors or descendants of each other");
        }
      }
      const treeEntries = [];
      for (const file of input.files) {
        const blob = await request<{ sha: string }>("POST", `${root}/git/blobs`, {
          content: file.content,
          encoding: "utf-8",
        });
        treeEntries.push({
          path: file.path,
          mode: entries.get(file.path)?.mode ?? "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
      return await request<{ sha: string }>("POST", `${root}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeEntries,
      });
    };
    const commitMessage = commitMessageFor(baseRef.object.sha);
    const tree = await buildExpectedTree(baseRef.object.sha);
    const approvedCommitBase = async (sha: string) => {
      const candidate = await request<{
        message: string;
        parents: Array<{ sha: string }>;
        tree: { sha: string };
      }>("GET", `${root}/git/commits/${sha}`);
      const candidateBase = candidate.parents[0]?.sha;
      const expectedTree = candidateBase ? await buildExpectedTree(candidateBase) : null;
      if (
        !candidateBase ||
        candidate.parents.length !== 1 ||
        candidate.message !== commitMessageFor(candidateBase) ||
        candidate.tree.sha !== expectedTree?.sha
      ) {
        throw new CommitMismatchError(
          `Branch ${input.branch} already exists but does not match this approved change`,
        );
      }
      return candidateBase;
    };
    const assertMatchingCommit = async (sha: string, currentBaseSha = baseRef.object.sha) => {
      if (await approvedCommitBase(sha) !== currentBaseSha) {
        throw new CommitMismatchError(
          `Branch ${input.branch} is based on a stale version of the approved base`,
        );
      }
    };
    const revalidateRecoveredPull = async (number: number, expectedHead: string) => {
      const pull = await request<{
        number: number;
        html_url: string;
        head: { sha: string };
        base: { ref: string };
        state: string;
        draft: boolean;
        title: string;
        body: string | null;
      }>("GET", `${root}/pulls/${number}`);
      if (
        pull.state !== "open" || !pull.draft || pull.base.ref !== baseBranch ||
        pull.title !== input.title || (pull.body ?? "") !== operationBody ||
        pull.head.sha.toLowerCase() !== expectedHead.toLowerCase()
      ) {
        throw new CreatedPullInvariantError("Recovered pull request changed during validation");
      }
      await assertMatchingCommit(pull.head.sha, await liveBaseSha());
      return pull;
    };
    const openPulls = operation.pull_request_number === null ? await listPulls() : [];
    let alreadyOpen = operation.pull_request_number === null
      ? openPulls.find((pull) => (pull.body ?? "") === operationBody) ?? openPulls[0]
      : await request<{
          number: number;
          html_url: string;
          head: { sha: string };
          draft: boolean;
          title: string;
          body: string | null;
          state: string;
        }>("GET", `${root}/pulls/${operation.pull_request_number}`);
    if (alreadyOpen) {
      if ("state" in alreadyOpen && alreadyOpen.state !== "open") {
        if (!operation.retryable_closure || (alreadyOpen.body ?? "") !== operationBody) {
          throw new Error("The operation-bound pull request is no longer open");
        }
        await approvedCommitBase(alreadyOpen.head.sha);
        await releaseOperationPull(alreadyOpen.number);
        alreadyOpen = undefined;
      }
    }
    if (alreadyOpen) {
      if (!alreadyOpen.draft) {
        throw new Error("Refusing to recover a pull request that is no longer a draft");
      }
      if (alreadyOpen.title !== input.title || (alreadyOpen.body ?? "") !== operationBody) {
        if (operation.pull_request_number === alreadyOpen.number) {
          await request("PATCH", `${root}/pulls/${alreadyOpen.number}`, { state: "closed" }, false);
        }
        throw new Error("Refusing to recover a pull request with different title or body");
      }
      await claimOperationPull(alreadyOpen.number);
      let validatedOpen;
      try {
        await assertMatchingCommit(alreadyOpen.head.sha, await liveBaseSha());
        validatedOpen = await revalidateRecoveredPull(alreadyOpen.number, alreadyOpen.head.sha);
      } catch (validationError) {
        if ((validationError instanceof CommitMismatchError ||
          validationError instanceof CreatedPullInvariantError) && operationOwnsPull(alreadyOpen)) {
          if (validationError instanceof CommitMismatchError &&
            !await store.markRetryableClosure(operation.id, alreadyOpen.number)) {
            throw new Error("Could not fence stale-base pull request cleanup");
          }
          await request("PATCH", `${root}/pulls/${alreadyOpen.number}`, { state: "closed" }, false);
          if (validationError instanceof CommitMismatchError) {
            await releaseOperationPull(alreadyOpen.number);
          }
        }
        throw validationError;
      }
      return {
        owner: input.owner,
        repo: input.repo,
        number: validatedOpen.number,
        url: validatedOpen.html_url,
        branch: activeBranch,
        commitSha: validatedOpen.head.sha,
        draft: validatedOpen.draft,
        recovered: true,
      };
    }
    try {
      const existingRef = await request<{ object: { sha: string } }>(
        "GET",
        `${root}/git/ref/heads/${branchPathFor(activeBranch)}`,
      );
      let existingSha = existingRef.object.sha;
      const currentBase = await liveBaseSha();
      try {
        await assertMatchingCommit(existingSha, currentBase);
      } catch (error) {
        if (!(error instanceof CommitMismatchError)) throw error;
        await approvedCommitBase(existingSha);
        const nextBranch = `${input.branch.slice(0, 165)}-retry-${fingerprintFor(currentBase).slice(0, 12)}`;
        if (!await store.moveOperationBranch(operation.id, activeBranch, nextBranch)) {
          throw new Error("Change operation branch changed during stale-base recovery");
        }
        activeBranch = nextBranch;
        try {
          const successor = await request<{ object: { sha: string } }>(
            "GET", `${root}/git/ref/heads/${branchPathFor(activeBranch)}`,
          );
          await assertMatchingCommit(successor.object.sha, currentBase);
          existingSha = successor.object.sha;
        } catch (refError) {
          if (!(refError instanceof GitHubRequestError) || refError.status !== 404) throw refError;
          const refreshedTree = await buildExpectedTree(currentBase);
          const refreshed = await request<{ sha: string }>("POST", `${root}/git/commits`, {
            message: commitMessageFor(currentBase), tree: refreshedTree.sha, parents: [currentBase],
          });
          await request("POST", `${root}/git/refs`, {
            ref: `refs/heads/${activeBranch}`, sha: refreshed.sha,
          });
          existingSha = refreshed.sha;
        }
      }
      const pull = await createPull(baseBranch, existingSha);
      return {
        owner: input.owner,
        repo: input.repo,
        number: pull.number,
        url: pull.html_url,
        branch: activeBranch,
        commitSha: pull.commitSha,
        draft: pull.draft,
        recovered: true,
      };
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 404) throw error;
    }
    const commit = await request<{ sha: string }>("POST", `${root}/git/commits`, {
      message: commitMessage,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    });
    let commitSha = commit.sha;
    let createdRef = true;
    try {
      await request("POST", `${root}/git/refs`, {
        ref: `refs/heads/${activeBranch}`,
        sha: commit.sha,
      });
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
      let concurrent: { object: { sha: string } };
      try {
        concurrent = await request("GET", `${root}/git/ref/heads/${branchPathFor(activeBranch)}`);
      } catch {
        throw error;
      }
      await assertMatchingCommit(concurrent.object.sha, await liveBaseSha());
      commitSha = concurrent.object.sha;
      createdRef = false;
    }
    const pull = await createPull(baseBranch, commitSha);
    return {
      owner: input.owner,
      repo: input.repo,
      number: pull.number,
      url: pull.html_url,
      branch: activeBranch,
      commitSha: pull.commitSha,
      draft: pull.draft,
      recovered: !createdRef,
    };
  },
});

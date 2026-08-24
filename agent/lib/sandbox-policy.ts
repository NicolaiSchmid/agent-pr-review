export const createSandboxNetworkPolicy = (readOnlyToken?: string) => {
  const githubRules = readOnlyToken
    ? [
        {
          transform: [
            {
              headers: {
                authorization: `Basic ${Buffer.from(`x-access-token:${readOnlyToken}`).toString("base64")}`,
              },
            },
          ],
        },
      ]
    : [];

  return {
    allow: {
      "github.com": githubRules,
      "*.github.com": [],
      "*.githubusercontent.com": [],
      "registry.npmjs.org": [],
      "*.npmjs.org": [],
      "pnpm.io": [],
      "*.pnpm.io": [],
    },
  };
};

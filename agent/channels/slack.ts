import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";
import { env } from "../lib/env.js";

export default slackChannel({
  credentials: connectSlackCredentials(env.slackConnector),
  threadContext: { since: "last-agent-reply" },
});

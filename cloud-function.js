import serverless from "serverless-http";

process.env.TCB_HTTP_FUNCTION = "1";

const { default: app } = await import("./server/index.mjs");

const handler = serverless(app, {
  binary: ["image/*", "application/octet-stream"],
});

export const main = async (event, context) => handler(event, context);

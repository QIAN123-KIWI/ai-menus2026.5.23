const serverless = require("serverless-http");

let handlerPromise;

exports.main = async (event, context) => {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      process.env.TCB_HTTP_FUNCTION = "1";
      const mod = await import("./server/index.mjs");
      const app = mod.default || mod.app;
      return serverless(app, {
        binary: ["image/*", "application/octet-stream"],
      });
    })();
  }

  const handler = await handlerPromise;
  return handler(event, context);
};

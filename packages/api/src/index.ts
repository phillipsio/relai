import { buildServer } from "./server.js";

const port = Number(process.env.API_PORT ?? 3010);
const host = process.env.API_HOST ?? "0.0.0.0";

const server = buildServer();

server.listen({ port, host }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
});

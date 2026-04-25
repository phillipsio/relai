import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: { code: "unauthorized", message: "Missing bearer token" } });
    }
    const token = auth.slice(7);
    if (token !== process.env.API_SECRET) {
      return reply.status(401).send({ error: { code: "unauthorized", message: "Invalid token" } });
    }
  });
};

export default fp(authPlugin);

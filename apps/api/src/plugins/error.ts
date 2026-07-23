// apps/api/src/plugins/errorHandler.ts
import fp from "fastify-plugin";
import {
  FastifyInstance,
  FastifyError,
  FastifyReply,
  FastifyRequest,
} from "fastify";

export default fp(async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler(
    async (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      fastify.log.error(error);

      const statusCode = error.statusCode || 500;
      const message =
        statusCode === 500 ? "Internal Server Error" : error.message;

      reply.code(statusCode).send({
        error: message,
        ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
      });
    },
  );
});

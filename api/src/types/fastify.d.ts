import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: any;
  }
}

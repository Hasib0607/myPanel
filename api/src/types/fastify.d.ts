import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: any;
  }

  interface RouteShorthandOptions {
    websocket?: boolean;
  }
}

import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: any;
    requireAccount: any;
  }

  interface RouteShorthandOptions {
    websocket?: boolean;
  }
}

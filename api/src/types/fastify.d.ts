import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: any;
    requireAccount: any;
    requireMail: any;
  }

  interface RouteShorthandOptions {
    websocket?: boolean;
  }
}

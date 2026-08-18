import { createService } from "./service.ts";

const service = createService();
service.transportReady.then(() => {
  service.logger.info("transport.ready", { mode: service.config.transportMode });
}).catch(() => {
  // Keep health endpoints available so operators receive an explicit TLS_UNAVAILABLE readiness response.
});
service.server.listen(service.config.port, service.config.host, () => {
  service.logger.info("server.started", { host: service.config.host, port: service.config.port, configVersion: service.config.version });
});

const shutdown = () => {
  service.server.close(() => {
    service.images.close();
    service.sessions.close();
    void Promise.allSettled([service.tlsTransport.close(), service.powPool.close()]).finally(() => process.exit(0));
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

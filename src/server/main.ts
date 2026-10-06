import { createApp } from './app.js';

const service = await createApp();
await service.app.listen({ host: '127.0.0.1', port: service.config.port });
console.log(`PasCap media service · http://127.0.0.1:${service.config.port}`);
console.log(`Local generated assets · ${service.config.dataDir}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.app.close().then(() => process.exit(0));
  });
}

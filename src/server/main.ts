import { toolchainNotice } from '../shared/toolchain.js';
import { createApp } from './app.js';
import { createConfig } from './config.js';
import { checkToolchain } from './toolchain.js';

const config = createConfig();
const toolchain = await checkToolchain(config);
const service = await createApp(config, toolchain);
await service.app.listen({ host: '127.0.0.1', port: service.config.port });
console.log(`PasCap media service · http://127.0.0.1:${service.config.port}`);
console.log(`Local generated assets · ${service.config.dataDir}`);
const notice = toolchainNotice(toolchain);
if (notice) console.warn(`Native toolchain ${notice.severity} · ${notice.message}`);
else console.log(`Native toolchain · FFmpeg ${toolchain.ffmpeg.version} (${toolchain.ffmpeg.command})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.app.close().then(() => process.exit(0));
  });
}

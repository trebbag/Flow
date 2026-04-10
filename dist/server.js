import { buildApp } from "./app.js";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
const app = buildApp();
async function start() {
    try {
        await app.listen({ port: env.PORT, host: env.HOST });
    }
    catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}
start();
process.on("SIGTERM", async () => {
    await prisma.$disconnect();
    process.exit(0);
});
process.on("SIGINT", async () => {
    await prisma.$disconnect();
    process.exit(0);
});
//# sourceMappingURL=server.js.map
export async function registerHealthRoutes(app) {
    app.get("/health", async () => {
        return { status: "ok" };
    });
}
//# sourceMappingURL=health.js.map
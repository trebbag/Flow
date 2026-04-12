process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "hybrid";
process.env.AUTH_ALLOW_DEV_HEADERS = "true";
process.env.AUTH_ALLOW_IMPLICIT_ADMIN = "false";
process.env.JWT_SECRET = process.env.JWT_SECRET || "dev-local-secret-change-before-pilot";
process.env.JWT_ISSUER = process.env.JWT_ISSUER || "flow.local";
process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || "flow-web";

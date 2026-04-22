export const PHI_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-proof-secret"]',
  'req.headers["x-dev-user-id"]',
  'req.headers["x-dev-role"]',
  'req.headers["x-proof-user-id"]',
  'req.headers["x-proof-role"]',
  'req.headers["x-facility-id"]',
  'req.headers["x-correlation-id"]',
  'req.headers["idempotency-key"]',
  'req.body.displayName',
  'req.body.dateOfBirth',
  'req.body.email',
  'req.body.phone',
  'req.body.patientId',
  'req.body.patientRecordId',
  'req.body.intakeData',
  'req.body.roomingData',
  'req.body.clinicianData',
  'req.body.checkoutData',
  'req.body.notes',
  'req.body.closureNotes',
  'req.body.description',
  'res.headers["set-cookie"]',
  '*.displayName',
  '*.dateOfBirth',
  '*.email',
  '*.phone',
  '*.patientDisplayName',
  '*.intakeData',
  '*.roomingData',
  '*.clinicianData',
  '*.checkoutData',
  '*.notes',
  '*.closureNotes',
  '*.beforeJson',
  '*.afterJson',
];

export const LOGGER_REDACT_OPTIONS = {
  paths: PHI_REDACT_PATHS,
  censor: '[REDACTED]',
  remove: false,
};

export function buildLoggerOptions(nodeEnv: string): boolean | Record<string, unknown> {
  if (nodeEnv === 'test') return false;
  return {
    level: process.env.LOG_LEVEL || 'info',
    redact: LOGGER_REDACT_OPTIONS,
    serializers: {
      req: (request: { id?: string; method?: string; url?: string; headers?: Record<string, unknown> }) => ({
        id: request.id,
        method: request.method,
        url: stripQueryPhi(request.url ?? ''),
        correlationId: request.headers?.['x-correlation-id'],
      }),
      res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
      err: (err: Error & { code?: string; statusCode?: number }) => ({
        type: err.name,
        code: err.code,
        statusCode: err.statusCode,
        message: err.message,
      }),
    },
  };
}

function stripQueryPhi(url: string): string {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;
  const base = url.slice(0, queryIndex);
  const query = url.slice(queryIndex + 1);
  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const [key] = pair.split('=');
      if (!key) return pair;
      if (/patient|email|phone|name|dob|birth/i.test(key)) {
        return `${key}=[REDACTED]`;
      }
      return pair;
    })
    .join('&');
  return redactedQuery ? `${base}?${redactedQuery}` : base;
}

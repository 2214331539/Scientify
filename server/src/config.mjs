const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid integer configuration: ${value}`);
  }
  return parsed;
};

const optional = (env, key) => String(env[key] ?? '').trim();

export function readConfig(env = process.env) {
  const models = optional(env, 'OFFICIAL_MODELS_JSON');
  let officialModels = [];
  if (models) {
    officialModels = JSON.parse(models);
    if (!Array.isArray(officialModels)) throw new Error('OFFICIAL_MODELS_JSON must be an array');
  }
  return {
    host: optional(env, 'HOST') || '127.0.0.1',
    port: integer(env.PORT, 8081, 1, 65535),
    databaseUrl: optional(env, 'DATABASE_URL'),
    jwtSecret: optional(env, 'JWT_SECRET'),
    jwtIssuer: optional(env, 'JWT_ISSUER') || 'scientify-collaboration',
    accessTokenTtl: integer(env.ACCESS_TOKEN_TTL_SECONDS, 900, 60, 86_400),
    refreshTokenTtl: integer(env.REFRESH_TOKEN_TTL_SECONDS, 2_592_000, 600, 31_536_000),
    oss: {
      endpoint: optional(env, 'OSS_ENDPOINT'),
      bucket: optional(env, 'OSS_BUCKET'),
      accessKeyId: optional(env, 'OSS_ACCESS_KEY_ID'),
      accessKeySecret: optional(env, 'OSS_ACCESS_KEY_SECRET'),
      urlTtl: integer(env.OSS_URL_TTL_SECONDS, 900, 60, 3600),
    },
    sms: {
      accessKeyId: optional(env, 'SMS_ACCESS_KEY_ID') || optional(env, 'ALIBABA_CLOUD_ACCESS_KEY_ID') || optional(env, 'ALIBABA_CLOUD_SMS_ACCESS_KEY_ID'),
      accessKeySecret: optional(env, 'SMS_ACCESS_KEY_SECRET') || optional(env, 'ALIBABA_CLOUD_ACCESS_KEY_SECRET') || optional(env, 'ALIBABA_CLOUD_SMS_ACCESS_KEY_SECRET'),
      signName: optional(env, 'SMS_SIGN_NAME') || optional(env, 'ALIBABA_CLOUD_SMS_SIGN_NAME'),
      templateCode: optional(env, 'SMS_TEMPLATE_CODE') || optional(env, 'ALIBABA_CLOUD_SMS_TEMPLATE_CODE'),
      regionId: optional(env, 'SMS_REGION_ID') || 'cn-hangzhou',
      dryRun: String(env.SMS_DRY_RUN ?? '').toLowerCase() === 'true',
      developmentCode: optional(env, 'DEV_SMS_CODE'),
    },
    officialModel: {
      endpoint: optional(env, 'OFFICIAL_MODEL_ENDPOINT'),
      chatEndpoint: optional(env, 'OFFICIAL_MODEL_CHAT_ENDPOINT'),
      apiKey: optional(env, 'OFFICIAL_MODEL_API_KEY'),
      defaultModel: optional(env, 'OFFICIAL_MODEL_ID'),
      provider: optional(env, 'OFFICIAL_MODEL_PROVIDER') || 'openai',
      models: officialModels,
      maxBodyBytes: integer(env.MAX_MODEL_BODY_BYTES, 4_194_304, 16_384, 16_777_216),
    },
  };
}

export function assertProductionConfig(config) {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.jwtSecret.length < 32) missing.push('JWT_SECRET(32+ chars)');
  if (!config.oss.endpoint) missing.push('OSS_ENDPOINT');
  if (!config.oss.bucket) missing.push('OSS_BUCKET');
  if (!config.oss.accessKeyId) missing.push('OSS_ACCESS_KEY_ID');
  if (!config.oss.accessKeySecret) missing.push('OSS_ACCESS_KEY_SECRET');
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
}

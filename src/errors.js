export class ConfigError extends Error {
  constructor(missing) {
    super(`Variáveis de ambiente faltando no .env: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

export class AuthError extends Error {
  constructor(service) {
    super(`Login do ${service} inválido ou expirado. Rode: node index.js auth ${service}`);
    this.name = 'AuthError';
    this.service = service;
  }
}

export class LimitReachedError extends Error {
  constructor(message = 'Limite de publicações do TikTok atingido') {
    super(message);
    this.name = 'LimitReachedError';
  }
}

export class TikTokApiError extends Error {
  constructor(message, { code, httpStatus } = {}) {
    super(message);
    this.name = 'TikTokApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

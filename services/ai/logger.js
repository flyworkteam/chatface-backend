const namespace = '[AI]';
const verboseLoggingEnabled = process.env.AI_VERBOSE_LOGS === 'true';

const log = (...args) => {
  console.log(namespace, ...args);
};

const debug = (...args) => {
  if (!verboseLoggingEnabled) {
    return;
  }
  console.log(namespace, ...args);
};

const warn = (...args) => {
  console.warn(namespace, ...args);
};

const error = (...args) => {
  console.error(namespace, ...args);
};

module.exports = {
  debug,
  log,
  warn,
  error
};

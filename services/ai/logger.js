const namespace = '[AI]';

const log = (...args) => {
  console.log(namespace, ...args);
};

const warn = (...args) => {
  console.warn(namespace, ...args);
};

const error = (...args) => {
  console.error(namespace, ...args);
};

module.exports = {
  log,
  warn,
  error
};

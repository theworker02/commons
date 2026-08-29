const release = require('../../config/release.json');
const { ConfigurationError, validateEnvironment } = require('./env');

module.exports = {
  RELEASE: Object.freeze(release),
  RELEASE_VERSION: release.version,
  ConfigurationError,
  validateEnvironment
};

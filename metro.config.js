const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.watchFolders = (config.watchFolders ?? []).filter(
  (f) => !f.startsWith(path.join(__dirname, '.local'))
);

config.resolver = {
  ...config.resolver,
  blockList: [
    ...(config.resolver?.blockList ? [config.resolver.blockList].flat() : []),
    new RegExp(path.join(__dirname, '\\.local').replace(/\\/g, '\\\\') + '.*'),
  ],
};

module.exports = config;

// Metro/Babel require CommonJS config files; ESM exports are not supported here.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};

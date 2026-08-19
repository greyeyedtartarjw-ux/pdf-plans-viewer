const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// PDF.js runs inside the measurement WebView. Treat its prebuilt browser
// bundles as static files so native builds package them for offline use.
config.resolver.assetExts.push('txt');

module.exports = config;

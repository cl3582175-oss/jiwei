/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook entrypoints */
module.exports = require('./mac-signing.cjs').beforePack

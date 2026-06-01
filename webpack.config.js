const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  entry: {
    background: './src/background.js',
    sidepanel: './src/sidepanel.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  resolve: {
    fallback: {
      crypto: require.resolve('crypto-browserify'),
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer/'),
      os: require.resolve('os-browserify/browser'),
      path: require.resolve('path-browserify'),
      util: require.resolve('util/'),
      zlib: require.resolve('browserify-zlib'),
      http: require.resolve('http-browserify'),
      https: require.resolve('https-browserify'),
      fs: false,
      net: false,
      tls: false,
      child_process: false,
      url: false,
      assert: false,
      constants: false,
      vm: false,
    },
    extensions: ['.js', '.ts', '.json'],
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
    new HtmlWebpackPlugin({
      template: './src/sidepanel.html',
      filename: 'sidepanel.html',
      chunks: ['sidepanel'],
      inject: 'body',
    }),
    new CopyWebpackPlugin({
      patterns: [{ from: 'manifest.json', to: 'manifest.json' }],
    }),
  ],
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      // Allow ESM packages that use fully-specified imports (e.g. @coral-xyz/anchor)
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false,
        },
      },
    ],
  },
  // Reduce bundle size for extension
  optimization: {
    minimize: true,
  },
  performance: {
    hints: false,
  },
};

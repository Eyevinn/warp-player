const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  
  return {
    mode: isProduction ? 'production' : 'development',
    entry: './src/browser.ts',
    devtool: isProduction ? 'source-map' : 'inline-source-map',
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.(png|jpg|gif|svg)$/i,
          type: 'asset/resource',
        },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: {
        '.js': ['.js', '.ts']
      }
    },
    output: {
      filename: isProduction ? '[name].[contenthash].js' : 'bundle.js',
      path: path.resolve(__dirname, 'dist'),
      clean: true // Clean the output directory before emit
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/index.html',
        title: 'WARP Player',
        minify: isProduction ? {
          collapseWhitespace: true,
          removeComments: true,
          removeRedundantAttributes: true,
          removeScriptTypeAttributes: true,
          removeStyleLinkTypeAttributes: true,
          useShortDoctype: true
        } : false
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'src/assets/images/eyevinn-technology-logo-white-400px.png', to: 'eyevinn-technology-logo-white-400px.png' },
          { from: 'src/config.json', to: 'config.json' }
        ],
      }),
    ],
    devServer: {
      static: {
        directory: path.join(__dirname, 'dist'),
      },
      compress: true,
      port: 8080,
      https: true, // WebTransport requires HTTPS
      client: {
        overlay: true,
      },
    },
    optimization: {
      splitChunks: isProduction ? {
        chunks: 'all',
      } : false,
      minimize: isProduction
    },
  };
};